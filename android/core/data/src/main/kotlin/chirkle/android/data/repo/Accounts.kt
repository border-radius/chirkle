// Accounts (ANDROID.md §17): each a server and, once someone logs in there, a user, with a session, a database and
// files of its own. One is active, with the services of ChirkleServices running; the others are idle until switched to,
// and only built for a push or a notification's action.
package chirkle.android.data.repo

import chirkle.android.data.lib.Strings
import chirkle.android.data.api.ApiError
import chirkle.android.data.api.ChirkleApi
import chirkle.android.data.api.userOf
import chirkle.android.data.db.ChirkleDatabase
import chirkle.android.data.lib.ServerProblem
import chirkle.android.data.lib.newId
import chirkle.android.data.lib.pathOnServer
import chirkle.android.data.lib.serverAddress
import chirkle.android.data.model.User
import chirkle.android.data.pb.AuthStore
import chirkle.android.data.pb.MemoryAuthStore
import chirkle.android.data.pb.PbClient
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient

/** An account in the index: its id (naming its files) and server. [used]: when it was last active (epoch ms). */
@Serializable
data class AccountRef(val id: String, val server: String, val used: Long = 0)

/** What is kept of the accounts, with the device's own settings (§17.1). */
@Serializable
data class AccountIndex(val accounts: List<AccountRef> = emptyList(), val active: String = "", val secureScreens: Boolean = false, val theme: String = "system", val folded: String = "")

/** An account as the switcher shows it: [user] is null on the Log in screen of a server (a guest). */
data class AccountInfo(val id: String, val server: String, val user: User?, val avatarUrl: String)

/** Where accounts keep what they keep: the app's files and the Keystore, or memory in tests. */
interface AccountEnv {
    suspend fun readIndex(): AccountIndex

    suspend fun writeIndex(index: AccountIndex)

    /** [id]'s session, read from storage on first use. */
    suspend fun authStore(id: String): AuthStore

    /** [id]'s database, opened on first use (one instance per account). */
    fun database(id: String): ChirkleDatabase

    fun hooks(id: String): SessionHooks

    /** [id] is gone: its session, database and files deleted, its notifications and pending work cancelled. */
    suspend fun delete(id: String)
}

class Accounts(
    private val env: AccountEnv,
    private val http: OkHttpClient,
    private val main: CoroutineDispatcher,
    /** The build's server (§17.2), "" for none: the first launch's Log in screen. */
    defaultServer: String,
    /** http addresses too: debug builds only (§17.2). */
    private val allowHttp: Boolean,
) {
    val scope = CoroutineScope(SupervisorJob() + main)
    val defaultServer: String = runCatching { serverAddress(defaultServer, allowHttp = true) }.getOrDefault("")

    private val lock = Mutex()
    private var loaded = false
    private var index = AccountIndex()
    private val stores = mutableMapOf<String, AuthStore>()
    private val built = mutableMapOf<String, ChirkleServices>()
    private val anonymous = mutableMapOf<String, ChirkleApi>()
    private var visible = false
    private var watch: Job? = null

    private val activeState = MutableStateFlow<ChirkleServices?>(null)

    /** The active account's services; null before [start], or when there is no account yet (choose a server). */
    val active: StateFlow<ChirkleServices?> = activeState.asStateFlow()

    private val listState = MutableStateFlow<List<AccountInfo>>(emptyList())

    /** Every account, in the order they were added. */
    val list: StateFlow<List<AccountInfo>> = listState.asStateFlow()

    /** The device's settings, the same whichever account is active. */
    val settings = DeviceSettings(
        read = { k ->
            when (k) {
                chirkle.android.data.db.Keys.THEME -> index.theme
                chirkle.android.data.db.Keys.FOLDED -> index.folded
                else -> if (index.secureScreens) "1" else "0"
            }
        },
        write = { k, v ->
            lock.withLock {
                index = when (k) {
                    chirkle.android.data.db.Keys.THEME -> index.copy(theme = v)
                    chirkle.android.data.db.Keys.FOLDED -> index.copy(folded = v)
                    else -> index.copy(secureScreens = v == "1")
                }
                env.writeIndex(index)
            }
        },
        scope = scope,
    )

    /** Read the accounts, once. Background work (a push, a notification's action) needs no more than this. */
    suspend fun load() = lock.withLock { loadLocked() }

    private suspend fun loadLocked() = withContext(main) {
        if (loaded) return@withContext
        index = env.readIndex()
        for (r in index.accounts) stores[r.id] = env.authStore(r.id)
        settings.load()
        if (index.accounts.isEmpty() && defaultServer.isNotEmpty()) {
            index = index.copy(accounts = listOf(AccountRef(newId(), defaultServer, System.currentTimeMillis())))
            stores[index.accounts[0].id] = env.authStore(index.accounts[0].id)
            env.writeIndex(index)
        }
        loaded = true
        refreshList()
    }

    /** Load, start the account that was active, then renew the idle accounts' sessions (§17.1). */
    suspend fun start() {
        lock.withLock {
            loadLocked()
            val id = index.active.takeIf { a -> index.accounts.any { it.id == a } } ?: index.accounts.maxByOrNull { it.used }?.id
            if (id != null && activeState.value == null) activateLocked(id)
        }
        scope.launch { renewIdle() }
    }

    /** The services of account [id], built (not started) when it isn't the active one; null for no such account. */
    suspend fun services(id: String): ChirkleServices? = lock.withLock {
        loadLocked()
        servicesLocked(id)
    }

    /** The account signed in as [userId] (a push names its user, §17.4). */
    suspend fun forUser(userId: String): ChirkleServices? {
        load()
        val id = index.accounts.firstOrNull { userOf(stores[it.id]?.session?.value ?: return@firstOrNull false)?.id == userId }?.id ?: return null
        return services(id)
    }

    /**
     * The account [url] belongs to (§17.3), with the link's path on its server: the active account first, then the
     * most recently used. A link to the default server with no account there adds one, as a guest.
     */
    suspend fun forLink(url: String): Pair<String, List<String>>? {
        load()
        val order = index.accounts.sortedWith(compareByDescending<AccountRef> { it.id == index.active }.thenByDescending { it.used })
        for (r in order) pathOnServer(r.server, url)?.let { return r.id to it }
        val path = defaultServer.takeIf { it.isNotEmpty() }?.let { pathOnServer(it, url) } ?: return null
        return add(defaultServer).accountId to path
    }

    /** Make [id] the active account. Leaving an account with nobody logged in removes it (§17.1). */
    suspend fun switchTo(id: String) = lock.withLock { activateLocked(id) }

    /**
     * The address [input] means, checked (§17.2): a server that answers and runs the chat. Throws [ServerProblem] with
     * what to show.
     */
    suspend fun check(input: String): String {
        val server = serverAddress(input, allowHttp)
        val api = ChirkleApi(PbClient(server, http, MemoryAuthStore()))
        try {
            api.health()
            api.site()
        } catch (e: ApiError) {
            throw ServerProblem(if (e.status == 0) Strings.CANT_REACH_THAT_SERVER_CHECK_THE else Strings.THAT_ADDRESS_ISNT_A_CHAT_SERVER)
        } catch (e: Exception) {
            throw ServerProblem(Strings.THAT_ADDRESS_ISNT_A_CHAT_SERVER)
        }
        return server
    }

    /** A new account on [server] (checked), made active: its Log in screen. */
    suspend fun add(server: String): ChirkleServices = lock.withLock {
        loadLocked()
        val ref = AccountRef(newId(), server, System.currentTimeMillis())
        stores[ref.id] = env.authStore(ref.id)
        index = index.copy(accounts = index.accounts + ref)
        env.writeIndex(index)
        activateLocked(ref.id)
        built.getValue(ref.id)
    }

    /** The app came to the foreground or went to the background. */
    fun setVisible(v: Boolean) {
        visible = v
        activeState.value?.setVisible(v)
    }

    /** Stop everything (tests). */
    suspend fun close() = lock.withLock {
        watch?.cancel()
        for (s in built.values) s.close()
        built.clear()
        activeState.value = null
    }

    private suspend fun servicesLocked(id: String): ChirkleServices? {
        built[id]?.let { return it }
        val ref = index.accounts.firstOrNull { it.id == id } ?: return null
        val store = stores.getOrPut(id) { env.authStore(id) }
        return ChirkleServices(ref.server, http, store, env.database(id), main, env.hooks(id), accountId = id, settings = settings).also { built[id] = it }
    }

    private suspend fun activateLocked(id: String): Unit = withContext(main) {
        val old = activeState.value
        if (old?.accountId == id || index.accounts.none { it.id == id }) return@withContext
        if (old != null) {
            watch?.cancel()
            activeState.value = null
            old.stop()
            built.remove(old.accountId)
            if (old.api.currentUser() == null) removeLocked(old.accountId)
        }
        val s = servicesLocked(id) ?: return@withContext
        val now = System.currentTimeMillis()
        index = index.copy(active = id, accounts = index.accounts.map { if (it.id == id) it.copy(used = now) else it })
        env.writeIndex(index)
        s.start()
        s.setVisible(visible)
        activeState.value = s
        watch = scope.launch { s.authStore.session.collect { onActiveSession(s) } }
        refreshList()
    }

    /** The active account's session changed: the list shows it; logging in as someone already here replaces them. */
    private suspend fun onActiveSession(s: ChirkleServices) {
        refreshList()
        val me = s.api.currentUser() ?: return
        lock.withLock {
            val twins = index.accounts.filter { it.id != s.accountId && it.server == s.server && userOf(stores[it.id]?.session?.value ?: return@filter false)?.id == me.id }
            for (t in twins) removeLocked(t.id)
        }
    }

    /** Renew the idle accounts' sessions, as starting renews the active one's; one the server refuses is removed. */
    private suspend fun renewIdle() {
        for (r in index.accounts.toList()) {
            if (r.id == activeState.value?.accountId) continue
            val s = services(r.id) ?: continue
            val refused = if (s.api.currentUser() == null) true else try {
                s.api.refreshAuth()
                false
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                // Only a refusal ends it; anything else (offline, an answer it can't read) leaves it for next time:
                // this runs in the accounts' scope, where a throw would end the app.
                val status = (e as? ApiError)?.status
                status == 401 || status == 403 || status == 404
            }
            if (refused) lock.withLock { if (r.id != activeState.value?.accountId) removeLocked(r.id) }
        }
        refreshList()
    }

    private suspend fun removeLocked(id: String) {
        built.remove(id)?.close()
        stores.remove(id)
        index = index.copy(accounts = index.accounts.filterNot { it.id == id })
        env.writeIndex(index)
        env.delete(id)
        refreshList()
    }

    private fun refreshList() {
        listState.value = index.accounts.map { r ->
            val user = stores[r.id]?.session?.value?.let(::userOf)
            val api = built[r.id]?.api ?: anonymous.getOrPut(r.server) { ChirkleApi(PbClient(r.server, http, MemoryAuthStore())) }
            AccountInfo(r.id, r.server, user, user?.let { api.avatarUrl(it, 96) }.orEmpty())
        }
    }
}
