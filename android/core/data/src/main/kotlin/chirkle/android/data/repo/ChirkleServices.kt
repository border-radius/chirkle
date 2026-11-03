// Everything the screens use, built once (ANDROID.md §4, §5: a hand-written graph, no DI framework). Owns the session:
// starts the services for whoever is logged in (or a guest, §23.3), and on a change of user stops them and clears what
// belonged to the last one (ANDROID.md §10).
package chirkle.android.data.repo

import chirkle.android.data.api.ApiError
import chirkle.android.data.api.ChirkleApi
import chirkle.android.data.api.toApiError
import chirkle.android.data.db.ChirkleDatabase
import chirkle.android.data.model.User
import chirkle.android.data.pb.AuthStore
import chirkle.android.data.pb.PbClient
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

/** What the app does around the session that core:data can't: notifications, image caches, background work. */
interface SessionHooks {
    /** Someone logged in (or the app started with a session): start the notification checks. */
    suspend fun onSignedIn(user: User) {}

    /** The session ended or changed hands: clear notifications, image caches, the launcher badge. */
    suspend fun onSignedOut() {}

    /** Ask WorkManager to send the outbox. */
    fun scheduleOutbox() {}
}

class ChirkleServices(
    serverUrl: String,
    http: OkHttpClient,
    val authStore: AuthStore,
    val db: ChirkleDatabase,
    /** The main thread: every service and controller runs there, as the web app runs on its one thread. */
    val main: CoroutineDispatcher,
    private val hooks: SessionHooks = object : SessionHooks {},
    /** The account these services are (ANDROID.md §17): names its notifications, work and files. */
    val accountId: String = "",
    /** The device's settings, shared by its accounts; without, kept in [db]. */
    settings: DeviceSettings? = null,
) {
    /** Lives as long as the process: writes (sends, edits, reads) outlive the screen that made them. */
    val appScope = CoroutineScope(SupervisorJob() + main)

    val pb = PbClient(serverUrl, http, authStore)

    /** The server's address, as the account has it (`https://host[/path]`). */
    val server: String = pb.base.toString().trimEnd('/')
    val api = ChirkleApi(pb)
    val store = Store()
    val tokens = FileTokens(api, appScope)
    val cache = RoomCache(db, appScope)
    val drafts = Drafts(db, appScope)
    val site = SiteRepository(api, db, store)
    val rooms = RoomsSync(api, store, db, main)
    val unread = Unread(api, store, db, main)
    val collections = CollectionsSync(api, store, main)
    val prefetch = Prefetch(api, store, cache, main)
    val outbox = Outbox(api, db, appScope) { hooks.scheduleOutbox() }
    val actions = RoomActions(api, store)
    val recentEmoji = RecentEmoji(db, appScope)
    val notifyCheck = NotifyCheck(api, db)
    val notifyRooms = NotifyRooms(db, appScope)
    /** When each room was last open, for Jump to's order. */
    val opened = chirkle.android.data.lib.RecentlyOpened()
    val settings = settings ?: DeviceSettings(db, appScope)

    private var who: String? = null
    private var backgroundJob: Job? = null

    /** Show what was kept, then start the session's services (call once, with the stored session loaded). */
    suspend fun start() = withContext(main) {
        site.loadCached()
        recentEmoji.load()
        notifyRooms.load()
        settings.load()
        appScope.launch { site.refresh() }
        sessionChanged()
        appScope.launch { authStore.session.collect { sessionChanged() } }
        // A room that leaves the loaded room list (taken out of a private room, deleted) is kept empty: nothing of it
        // shows again, opened from a link or a notification (the web's forgetGone, QA BUG-101; BUG-160).
        appScope.launch {
            var prev = store.get()
            store.flow.collect { s ->
                val p = prev
                prev = s
                if (s.roomsStatus != LoadStatus.Ready || p.roomsStatus != LoadStatus.Ready || s.user?.id != p.user?.id) return@collect
                for (id in p.rooms.keys) if (id !in s.rooms) cache.put(s.user?.id.orEmpty(), id, Kept(emptyList(), false))
            }
        }
        // Renew the session after launch, off the critical path; one the server refuses ends here.
        appScope.launch { checkSession() }
        api.onRejected { appScope.launch { checkSession() } }
        // A live connection the server closed may have been a ban's (DESIGN.md §36) or a revoked session's.
        appScope.launch { api.connects.collect { reconnect -> if (reconnect) checkSession() } }
    }

    private suspend fun sessionChanged() {
        val user = api.currentUser()
        val id = user?.id.orEmpty()
        if (id == who) {
            if (user != null && user != store.get().user) store.update { it.copy(user = user) }
            return
        }
        val first = who == null
        who = id
        opened.clear()
        unread.stop()
        collections.stop()
        prefetch.stop()
        rooms.stop()
        tokens.reset()
        // A session that ran out while the app was closed was never ended: what it saved goes now, before it shows
        // (its rooms, DMs included, to a guest; QA BUG-145).
        if (!first || api.forgetExpired().isNotEmpty()) {
            // Nothing of the last session may show for the next person (ANDROID.md §10).
            cache.clearMemory()
            db.clearSession()
            outbox.clear()
            recentEmoji.clear()
            notifyRooms.clear()
            hooks.onSignedOut()
            store.update { AppStateForSite(it) }
        }
        store.update { it.copy(user = user) }
        if (first) {
            rooms.loadSaved()
            if (user != null) unread.loadSaved()
        }
        rooms.start()
        if (user != null) {
            unread.start()
            collections.start()
            prefetch.start()
            outbox.drain()
            appScope.launch { runCatching { hooks.onSignedIn(user) } }
        }
    }

    /** When the session was last checked with the server (System.currentTimeMillis), 0 for never. */
    @Volatile private var checkedAt = 0L
    /** Coming back after this long, the session is checked again; tests shorten it. */
    var checkStaleMs = CHECK_STALE_MS

    /** Check the session with the server (which renews it); end it when refused. */
    private suspend fun checkSession() {
        if (api.currentUser() == null) return
        checkedAt = System.currentTimeMillis()
        try {
            api.refreshAuth()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            // Anything else (an answer it can't read) leaves the session as it is: this runs in appScope, where a throw
            // would end the app.
            val status = e.toApiError().status
            if (status == 401 || status == 403 || status == 404) logOut()
        }
    }

    suspend fun logIn(email: String, password: String): User = api.logIn(email, password)

    suspend fun signUp(email: String, password: String, name: String, inviteCode: String = ""): User = api.signUp(email, password, name, inviteCode)

    /** Send what was read, then end the session; everything of it is cleared. */
    suspend fun logOut() = withContext(main) {
        unread.flush()
        api.logOut()
    }

    /** The app came to the foreground or went to the background (ANDROID.md §9.1, DESIGN.md §22.4). */
    fun setVisible(visible: Boolean) {
        appScope.launch {
            store.update { it.copy(away = !visible) }
            backgroundJob?.cancel()
            if (visible) pb.realtime.resume()
            else backgroundJob = appScope.launch {
                delay(BACKGROUND_CLOSE_MS)
                pb.realtime.pause()
            }
            // Back after a while: the session may have been revoked meanwhile (a password changed elsewhere), and reads
            // with it would answer as to a guest: rooms "don't exist" (the web's renewal.visible, QA BUG-51, BUG-183).
            if (visible && System.currentTimeMillis() - checkedAt > checkStaleMs) checkSession()
        }
    }

    /**
     * The room screens open, oldest first: the newest is the active room. A screen can open before the one it replaces
     * is gone (a link or a notification to the room already open), and that one's close must not end the new one's.
     */
    private val openRooms = mutableListOf<String>()

    /** The room screen opened [roomId] (around [msgId]): its controller, started. [RoomController.close] ends it. */
    fun openRoom(roomId: String, msgId: String? = null): RoomController {
        openRooms += roomId
        store.update { it.copy(activeRoomId = roomId) }
        return RoomController(api, store, outbox, cache, tokens, roomId, msgId, main, appScope).also { it.start() }
    }

    /** A room screen closed: the room still open under it (or none) is active. */
    fun closeRoom(roomId: String) {
        openRooms.lastIndexOf(roomId).takeIf { it >= 0 }?.let { openRooms.removeAt(it) }
        store.update { it.copy(activeRoomId = openRooms.lastOrNull()) }
    }

    /** Another account became active: send what was read, then stop. */
    suspend fun stop() = withContext(main) {
        runCatching { unread.flush() }
        close()
    }

    /** Stop everything (tests; the process ending needs nothing). */
    suspend fun close() = withContext(main) {
        unread.stop()
        collections.stop()
        prefetch.stop()
        rooms.stop()
        pb.realtime.unsubscribeAll()
        appScope.coroutineContext[Job]?.cancel()
    }

    private companion object {
        /** The realtime connection closes this long after the app goes to the background. */
        const val BACKGROUND_CLOSE_MS = 5000L
        /** Coming back after this long, the session is checked again (the web's CHECK_STALE_MS). */
        const val CHECK_STALE_MS = 5 * 60 * 1000L

        /** What stays when the session ends: the site record and whether the app is visible. */
        fun AppStateForSite(s: AppState) = AppState(site = s.site, away = s.away)
    }
}
