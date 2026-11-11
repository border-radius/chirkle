// A throwaway server for the data integration tests (ANDROID.md §13): the repository's bin/chirkle-server, migrations
// and hooks, on a free port with a temp data dir, started once per test JVM, like tests/support/pocketbase.ts. And, when
// a test asks for it, a server from before the list routes (legacyUrl).
package chirkle.android.data.testing

import chirkle.android.data.api.ChirkleApi
import chirkle.android.data.model.User
import chirkle.android.data.pb.MemoryAuthStore
import chirkle.android.data.pb.PbClient
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.net.ServerSocket
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

object TestServer {
    const val ADMIN_EMAIL = "admin@test.local"
    const val ADMIN_PASSWORD = "test-password-123"
    const val PASSWORD = "password-123"

    val http: OkHttpClient = OkHttpClient.Builder().readTimeout(30, TimeUnit.SECONDS).build()
    private val counter = AtomicInteger()

    private val root: File by lazy {
        File(System.getProperty("chirkle.repoRoot") ?: error("chirkle.repoRoot is not set (run the tests from Gradle)"))
    }

    val url: String by lazy { start(File(root, "pb_hooks")) }

    /**
     * A server from before the list routes (docs/API.md, server/lists.go) and live messages (GET /api/chat/live,
     * server/live.go), which the app falls back from: an old release's hooks when `chirkle.legacyHooks` names them
     * (-Pchirkle.legacyHooks=…; their routes win over the server's), else these hooks with the server's
     * CHIRKLE_LEGACY=1, which leaves those routes out. The same migrations.
     */
    val legacyUrl: String by lazy {
        start(System.getProperty("chirkle.legacyHooks")?.let(::File) ?: File(root, "pb_hooks"), legacy = true)
    }

    private fun start(hooks: File, legacy: Boolean = false): String {
        val bin = File(root, "bin/chirkle-server")
        check(bin.canExecute()) { "No server at $bin: run `npm run setup` in the repository first" }
        val tmp = Files.createTempDirectory("chirkle-pb-android").toFile()
        val dirs = listOf(
            "--dir=${File(tmp, "pb_data")}",
            "--migrationsDir=${File(root, "pb_migrations")}",
            "--hooksDir=$hooks",
            "--automigrate=false",
        )
        ProcessBuilder(listOf(bin.path, "superuser", "upsert", ADMIN_EMAIL, ADMIN_PASSWORD) + dirs).redirectErrorStream(true).start().run {
            inputStream.readBytes()
            check(waitFor() == 0) { "superuser upsert failed" }
        }
        val port = ServerSocket(0).use { it.localPort }
        val url = "http://127.0.0.1:$port"
        val pb = File(tmp, "pb_public").apply { mkdirs() }
        val proc = ProcessBuilder(
            listOf(bin.path, "serve", "--http=127.0.0.1:$port", "--publicDir=$pb", "--hooksWatch=false", "--hooksPool=50") + dirs,
        ).redirectErrorStream(true).redirectOutput(File(tmp, "pb.log")).apply {
            environment().keys.removeIf { it.startsWith("TELEGRAM_") }
            environment()["LINK_PREVIEWS"] = "off"
            // Linked instances (DESIGN.md §33) over http on 127.0.0.1; turned on below, so its routes answer. No peer
            // is ever paired.
            environment()["FEDERATION_ALLOW_PRIVATE"] = "1"
            if (legacy) environment()["CHIRKLE_LEGACY"] = "1"
        }.start()
        Runtime.getRuntime().addShutdownHook(Thread {
            proc.destroy()
            proc.waitFor(5, TimeUnit.SECONDS)
            tmp.deleteRecursively()
        })
        val deadline = System.currentTimeMillis() + 20_000
        while (true) {
            check(proc.isAlive) { "PocketBase exited:\n" + File(tmp, "pb.log").readText() }
            val ok = runCatching { http.newCall(Request.Builder().url("$url/api/health").build()).execute().use { it.isSuccessful } }.getOrDefault(false)
            if (ok) break
            check(System.currentTimeMillis() < deadline) { "PocketBase not healthy:\n" + File(tmp, "pb.log").readText() }
            Thread.sleep(50)
        }
        disableRateLimits(url)
        enableFederation(url)
        return url
    }

    /** Every test client connects from 127.0.0.1: limits meant for real users would trip across unrelated tests. */
    private fun disableRateLimits(url: String) {
        val token = adminToken(url)
        val body = """{"rateLimits":{"enabled":false}}""".toRequestBody("application/json".toMediaType())
        http.newCall(Request.Builder().url("$url/api/settings").header("Authorization", token).patch(body).build()).execute().use {
            check(it.isSuccessful) { "settings → ${it.code}" }
        }
    }

    /** Linked instances on (DESIGN.md §33.2): the Application URL is this server, and the site's `federation` ticked. */
    private fun enableFederation(url: String) {
        val token = adminToken(url)
        val json = "application/json".toMediaType()
        val settings = """{"meta":{"appURL":"$url"}}""".toRequestBody(json)
        http.newCall(Request.Builder().url("$url/api/settings").header("Authorization", token).patch(settings).build()).execute().use {
            check(it.isSuccessful) { "settings → ${it.code}" }
        }
        val site = http.newCall(Request.Builder().url("$url/api/collections/site/records?perPage=1").build()).execute().use {
            Regex("\"id\":\"([^\"]+)\"").find(it.body.string())!!.groupValues[1]
        }
        val on = """{"federation":true}""".toRequestBody(json)
        http.newCall(Request.Builder().url("$url/api/collections/site/records/$site").header("Authorization", token).patch(on).build()).execute().use {
            check(it.isSuccessful) { "site → ${it.code}" }
        }
    }

    private fun adminToken(url: String = this.url): String {
        val body = """{"identity":"$ADMIN_EMAIL","password":"$ADMIN_PASSWORD"}""".toRequestBody("application/json".toMediaType())
        http.newCall(Request.Builder().url("$url/api/collections/_superusers/auth-with-password").post(body).build()).execute().use {
            check(it.isSuccessful) { "superuser login → ${it.code}" }
            return Regex("\"token\":\"([^\"]+)\"").find(it.body.string())!!.groupValues[1]
        }
    }

    /** Superuser request, for fixtures the API can't make (e.g. the site record). Returns the answer's body. */
    fun admin(method: String, path: String, json: String? = null): String {
        val body = json?.toRequestBody("application/json".toMediaType())
        http.newCall(Request.Builder().url("$url$path").header("Authorization", adminToken()).method(method, body).build()).execute().use {
            val text = it.body.string()
            check(it.isSuccessful) { "$method $path → ${it.code} $text" }
            return text
        }
    }

    fun uniq(): String = "${System.nanoTime().toString(36).takeLast(6)}${counter.incrementAndGet()}"

    /** A client of its own (an in-memory session), of the server at [at]. */
    fun client(at: String = url): ChirkleApi = ChirkleApi(PbClient(at, http, MemoryAuthStore()))

    class TestUser(val api: ChirkleApi, val user: User, val email: String)

    /** A new user, signed in on a client of its own (of the server at [at]). */
    fun newUser(name: String = "user-${uniq()}", at: String = url): TestUser = runBlocking {
        val api = client(at)
        val email = "$name@test.local"
        val user = api.signUp(email, PASSWORD, name)
        TestUser(api, user, email)
    }
}
