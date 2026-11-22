package chirkle.android.data.repo

import chirkle.android.data.lib.ServerProblem
import chirkle.android.data.pb.PbJson
import chirkle.android.data.pb.Session
import chirkle.android.data.testing.MemoryAccountEnv
import chirkle.android.data.testing.TestServer
import chirkle.android.data.testing.TestServer.newUser
import chirkle.android.data.testing.eventually
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.Base64
import java.util.concurrent.Executors

// Several servers and accounts (ANDROID.md §17), against the real server. "Another server" is the same one by another
// address (localhost for 127.0.0.1): to the app they are two servers.
@RunWith(RobolectricTestRunner::class)
class AccountsTest {
    private val main = Executors.newSingleThreadExecutor { r -> Thread(r, "test-main").apply { isDaemon = true } }.asCoroutineDispatcher()
    private val made = mutableListOf<Accounts>()
    private val other get() = TestServer.url.replace("127.0.0.1", "localhost")

    private fun accounts(env: MemoryAccountEnv = MemoryAccountEnv(), default: String = TestServer.url) =
        Accounts(env, TestServer.http, main, default, allowHttp = true).also { made += it }

    @After fun tearDown() = runBlocking { made.forEach { it.close() } }

    private fun Accounts.now() = active.value!!

    @Test fun `the first launch is the default server's Log in screen, or a choice of server without one`() = runBlocking {
        val a = accounts()
        a.start()
        assertEquals(TestServer.url, a.now().server)
        assertNull(a.list.value.single().user)
        val none = accounts(default = "")
        none.start()
        assertNull(none.active.value)
        assertTrue(none.list.value.isEmpty())
    }

    @Test fun `an address is checked before it is used`() = runBlocking {
        val a = accounts()
        assertEquals(other, a.check(other.removePrefix("http://").let { "http://$it/r/abcdefghij12345" }))
        assertEquals("That address isn't a chat server.", assertThrows(ServerProblem::class.java) { runBlocking { a.check("${TestServer.url}/not-here") } }.message)
        assertEquals("Can't reach that server. Check the address and your connection.", assertThrows(ServerProblem::class.java) { runBlocking { a.check("http://127.0.0.1:1") } }.message)
    }

    @Test fun `accounts on two servers are added and switched, and each push finds its own`() = runBlocking {
        val u = newUser()
        val v = newUser()
        val a = accounts()
        a.start()
        val first = a.now()
        first.logIn(u.email, TestServer.PASSWORD)
        eventually(what = "listed") { a.list.value.single().user?.id == u.user.id }

        val second = a.add(a.check(other))
        assertEquals(second, a.now())
        assertEquals(other, second.server)
        second.logIn(v.email, TestServer.PASSWORD)
        eventually(what = "both listed") { a.list.value.mapNotNull { it.user?.id } == listOf(u.user.id, v.user.id) }

        a.switchTo(first.accountId)
        assertEquals(first.accountId, a.now().accountId)
        eventually(what = "rooms") { a.now().store.get().roomsStatus == LoadStatus.Ready }
        assertEquals(u.user.id, a.now().store.get().user?.id)
        // Idle, the other account still answers for its pushes and links.
        assertEquals(second.accountId, a.forUser(v.user.id)?.accountId)
        assertEquals(second.accountId to listOf("r", "abcdefghij12345"), a.forLink("$other/r/abcdefghij12345"))
        assertEquals(first.accountId, a.forLink("${TestServer.url}/r/abcdefghij12345")?.first)
    }

    @Test fun `leaving a server without logging in forgets it`() = runBlocking {
        val u = newUser()
        val env = MemoryAccountEnv(listOf(TestServer.url to u.api.pb.authStore.session.value))
        val a = accounts(env)
        a.start()
        val guest = a.add(a.check(other))
        a.switchTo("acct0")
        assertEquals(listOf("acct0"), a.list.value.map { it.id })
        assertEquals(listOf(guest.accountId), env.deleted)
    }

    @Test fun `logging in again as someone already here replaces their older account`() = runBlocking {
        val u = newUser()
        val env = MemoryAccountEnv(listOf(TestServer.url to u.api.pb.authStore.session.value))
        val a = accounts(env)
        a.start()
        val again = a.add(a.check(TestServer.url))
        again.logIn(u.email, TestServer.PASSWORD)
        eventually(what = "the older one gone") { a.list.value.map { it.id } == listOf(again.accountId) }
        assertEquals(listOf("acct0"), env.deleted)
    }

    @Test fun `an idle account whose session the server refuses is removed`() = runBlocking {
        val u = newUser()
        val claims = Base64.getUrlEncoder().withoutPadding().encodeToString("""{"exp":4102444800}""".toByteArray())
        val forged = Session("x.$claims.y", PbJson.parseToJsonElement("""{"id":"abcdefghij12345","collectionName":"users"}""") as JsonObject)
        val env = MemoryAccountEnv(listOf(TestServer.url to u.api.pb.authStore.session.value, other to forged))
        val a = accounts(env)
        a.start()
        eventually(what = "the refused one removed") { a.list.value.map { it.id } == listOf("acct0") }
        assertEquals(listOf("acct1"), env.deleted)
        assertNotEquals(null, a.now().api.currentUser())
    }

    @Test fun `the text size is the device's, kept in the index, and an old index is Small`() = runBlocking {
        val env = MemoryAccountEnv()
        val a = accounts(env)
        a.start()
        assertEquals(TextSize.Small, a.settings.textSize.value)
        a.settings.setTextSize(TextSize.Large)
        eventually(what = "the size saved") { env.index.textSize == "large" }
        val b = accounts(env)
        b.start()
        assertEquals(TextSize.Large, b.settings.textSize.value)
        // An index from before the setting.
        assertEquals("small", PbJson.decodeFromString(AccountIndex.serializer(), """{"accounts":[],"theme":"dark"}""").textSize)
        assertEquals(TextSize.Small, TextSize.of("huge"))
    }
}
