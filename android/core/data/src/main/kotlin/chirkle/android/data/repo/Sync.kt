// The room list, hidden rows and unread counts, for as long as the app runs (DESIGN.md §7.4, §18.3): ports of
// web/src/sync.ts and unread.ts. Restarted whenever someone logs in or out. Screens only read the store.
package chirkle.android.data.repo

import chirkle.android.data.api.Action
import chirkle.android.data.api.ChirkleApi
import chirkle.android.data.api.toApiError
import chirkle.android.data.db.ChirkleDatabase
import chirkle.android.data.db.Keys
import chirkle.android.data.db.KvEntity
import chirkle.android.data.db.RoomEntity
import chirkle.android.data.model.Room
import chirkle.android.data.model.UnreadCounts
import chirkle.android.data.pb.PbJson
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Keeps the room list and the user's hidden rows in the store, and in the database for the next launch. */
class RoomsSync(private val api: ChirkleApi, private val store: Store, private val db: ChirkleDatabase, private val main: CoroutineDispatcher) {
    private var run: Run? = null
    private var guest = true
    private var issued = 0
    private var applied = 0
    private var inFlight = 0
    /** Rooms whose entry changed in the store while a load was out: their answer is older (QA BUG-69, BUG-107). */
    private var changedRooms = mutableSetOf<String>()
    private var changedHidden = mutableSetOf<String>()

    /** The room list as last saved, before the network answers (§6.3). */
    suspend fun loadSaved() {
        val rows = db.rooms().all()
        if (rows.isEmpty()) return
        val rooms = rows.mapNotNull { r -> runCatching { PbJson.decodeFromString(Room.serializer(), r.json) }.getOrNull() }
        store.update { s ->
            if (s.roomsStatus == LoadStatus.Ready) s
            else s.copy(rooms = rooms.associateBy { it.id }, hidden = rows.filter { it.hiddenRow.isNotEmpty() }.associate { it.id to it.hiddenRow })
        }
    }

    fun start() {
        if (run != null) return
        val r = Run(null, main)
        run = r
        guest = api.currentUser() == null
        r.defer(store.listen(::track))
        r.scope.launch {
            r.sub { api.subscribeRooms { c -> r.post { store.update { s -> if (c.action == Action.Delete) s.removeRoom(c.record.id) else s.upsertRoom(c.record) } } } }
            if (!guest) {
                r.sub {
                    api.subscribeHidden { c ->
                        r.post { store.update { s -> if (c.action == Action.Delete) s.unmarkHidden(c.record.id) else s.markHidden(c.record.room, c.record.id) } }
                    }
                }
            }
            launch { api.connects.collect { reconnect -> if (reconnect) load(r) } }
            launch { persist(r) }
            load(r)
        }
    }

    fun stop() {
        run?.dispose()
        run = null
    }

    suspend fun reload() {
        run?.let { load(it) }
    }

    private fun track(st: AppState, prev: AppState) {
        if (inFlight == 0) return
        if (st.rooms !== prev.rooms) for (id in st.rooms.keys + prev.rooms.keys) if (st.rooms[id] != prev.rooms[id]) changedRooms += id
        if (st.hidden !== prev.hidden) for (id in st.hidden.keys + prev.hidden.keys) if (st.hidden[id] != prev.hidden[id]) changedHidden += id
    }

    private suspend fun load(r: Run) {
        val seq = ++issued
        if (inFlight++ == 0) {
            changedRooms = mutableSetOf()
            changedHidden = mutableSetOf()
        }
        if (store.get().roomsStatus != LoadStatus.Ready) store.update { it.copy(roomsStatus = LoadStatus.Loading) }
        store.update { it.copy(listLoads = it.listLoads + 1) }
        try {
            val roomsP = r.scope.async { api.listRooms() }
            val hiddenP = r.scope.async { if (guest) emptyList() else api.listHidden() }
            val rooms = roomsP.await()
            val hidden = hiddenP.await()
            if (!r.active || seq < applied) return
            applied = seq
            store.update { now ->
                val answer = rooms.associateBy { it.id }.toMutableMap()
                for (id in changedRooms) now.rooms[id]?.let { answer[id] = it } ?: answer.remove(id)
                val hid = hidden.associate { it.room to it.id }.toMutableMap()
                for (id in changedHidden) now.hidden[id]?.let { hid[id] = it } ?: hid.remove(id)
                now.copy(rooms = answer, hidden = hid, roomsStatus = LoadStatus.Ready)
            }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (r.active && seq >= applied) store.update { it.copy(roomsStatus = LoadStatus.Error) }
        } finally {
            inFlight--
            store.update { it.copy(listLoads = it.listLoads - 1) }
        }
    }

    /** Write the list to the database once it has settled, for the next launch. */
    private suspend fun persist(r: Run) {
        var saved: Pair<Map<String, Room>, Map<String, String>>? = null
        store.flow.collect { s ->
            if (s.roomsStatus != LoadStatus.Ready || s.user == null) return@collect
            val now = s.rooms to s.hidden
            if (now == saved) return@collect
            delay(PERSIST_DELAY_MS)
            saved = now
            db.rooms().replace(s.rooms.values.map { RoomEntity(it.id, PbJson.encodeToString(Room.serializer(), it), s.hidden[it.id].orEmpty()) })
        }
    }

    private companion object {
        const val PERSIST_DELAY_MS = 500L
    }
}

/** What the room screen reports as read (the web's RoomReader). */
interface RoomReader {
    /**
     * The messages up to [created] have been on screen: read. [caughtUp] is whether that was the newest one (the room's
     * count is then cleared). Cheap to call on every frame.
     */
    fun seen(created: String, caughtUp: Boolean)

    /** Leaving the room: send a pending read now; refetch the counts unless the newest messages were on screen. */
    fun close(caughtUp: Boolean)
}

/** Unread counts (§18.3): keeps them in the store and tells the server what has been read. */
class Unread(
    private val api: ChirkleApi,
    private val store: Store,
    private val db: ChirkleDatabase,
    private val main: CoroutineDispatcher,
    private val refreshMs: Long = 250,
    private val readMs: Long = 1000,
    /** The first wait before a read that failed is sent again; it doubles with each failure, up to a minute. */
    private val retryMs: Long = 2000,
) {
    private var run: Run? = null
    private var recent = mutableListOf<Pair<String, String>>()
    private var accounted = setOf<String>()
    private var inFlight = 0
    private var countedAt = ""
    private var refreshJob: Job? = null
    private val pending = mutableSetOf<Sender>()

    /**
     * The open room while its newest messages are on screen (its reader last said caughtUp): its count is the room
     * screen's to clear, and what arrives in it is read as it comes. Scrolled up, or opened at its first unread message,
     * it keeps the server's count, badge included: the rest is still unread (2026-11-02, user).
     */
    private var following: String? = null

    private interface Sender {
        /** The request, if one went out. */
        fun send(): Job?
    }

    /** The counts as last saved (a cold start shows the badges at once); still to be confirmed by the server. */
    suspend fun loadSaved() {
        val saved = db.kv().get(Keys.UNREAD)?.let { runCatching { PbJson.decodeFromString(UnreadCounts.serializer(), it) }.getOrNull() } ?: return
        store.update { s -> if (s.counted) s else s.copy(unread = saved.rooms) }
    }

    private suspend fun load(r: Run) {
        inFlight++
        store.update { it.copy(listLoads = it.listLoads + 1) }
        try {
            val res = runCatching { api.unreadCounts() }.getOrNull()
            if (res == null || !r.active || res.at < countedAt) return
            countedAt = res.at
            accounted = res.ids.toSet()
            val unread = res.rooms.toMutableMap()
            for ((room, id) in recent) if (id !in accounted) unread[room] = (unread[room] ?: 0) + 1
            // The room you are caught up in is the room screen's to clear; not while the app is away (then nobody reads it).
            val mentions = res.mentions.toMutableMap()
            if (!store.get().away) following?.let {
                unread.remove(it)
                mentions.remove(it)
            }
            store.update { it.copy(unread = unread, counted = true, mentions = mentions, inbox = res.inbox) }
            db.kv().put(KvEntity(Keys.UNREAD, PbJson.encodeToString(UnreadCounts.serializer(), UnreadCounts(res.at, unread))))
        } finally {
            store.update { it.copy(listLoads = it.listLoads - 1) }
            if (--inFlight == 0) recent = mutableListOf()
        }
    }

    /** Refetch the counts soon (several calls in a row make one request). */
    fun refresh() {
        val r = run ?: return
        refreshJob?.cancel()
        refreshJob = r.scope.launch {
            delay(refreshMs)
            load(r)
        }
    }

    /** Send every pending read now (before the session ends). */
    fun flush() {
        pending.toList().forEach { it.send() }
    }

    fun open(roomId: String): RoomReader {
        val r = run
        val reader = store.get().user?.id.orEmpty()
        var readAt = ""
        var timer: Job? = null
        var closed = false
        var failures = 0
        // What the last seen() said: not caught up, the count is fetched again once a read is in.
        var caughtUpNow = false
        val live = { !closed && r != null && r.active && r === run }
        val self = object : Sender {
            override fun send(): Job? {
                val sender = this
                timer?.cancel()
                timer = null
                pending -= this
                if (r == null || !r.active || api.currentUser()?.id != reader) return null // never as someone else
                val at = readAt
                return r.scope.launch {
                    runCatching { api.markRead(roomId, at) }
                        .onSuccess {
                            failures = 0
                            // What is still unread below the screen: the server counts it.
                            if (!caughtUpNow && live()) refresh()
                        }
                        .onFailure { e ->
                            // Offline, or the server in trouble: sent again a little later. Nothing else may ask (the room
                            // on screen doesn't change), and the room would stay unread everywhere. A refusal is final.
                            if (e is kotlinx.coroutines.CancellationException) return@onFailure
                            val status = e.toApiError().status
                            if ((status in 400..499 && status != 429) || !live() || timer != null) return@onFailure
                            val wait = minOf(retryMs shl minOf(failures++, 5), MAX_RETRY_MS)
                            pending += sender
                            timer = r.scope.launch {
                                delay(wait)
                                sender.send()
                            }
                        }
                }
            }
        }
        return object : RoomReader {
            override fun seen(created: String, caughtUp: Boolean) {
                if (!live()) return
                caughtUpNow = caughtUp
                if (caughtUp) following = roomId else if (following == roomId) following = null
                // Not before the newest message: the rest is still unread (close() refetches the count).
                if (caughtUp) store.update { it.clearUnread(roomId) }
                if (created <= readAt) return
                readAt = created
                if (timer != null) return
                pending += self
                timer = r!!.scope.launch {
                    delay(readMs)
                    self.send()
                }
            }

            override fun close(caughtUp: Boolean) {
                if (closed) return
                if (following == roomId) following = null
                val sent = if (timer != null) self.send() else null
                if (live()) {
                    when {
                        caughtUp -> store.update { it.clearUnread(roomId) }
                        // After the read is in: counted before it, the messages just read would show as unread again.
                        sent != null -> r!!.scope.launch {
                            sent.join()
                            refresh()
                        }
                        else -> refresh()
                    }
                }
                closed = true
            }
        }
    }

    fun start() {
        if (run != null) return
        val r = Run(null, main)
        run = r
        countedAt = ""
        r.scope.launch {
            r.sub {
                api.subscribeAllMessages { c ->
                        r.post {
                            val s = store.get()
                            val m = c.record
                            // The room you are caught up in is read as it arrives, unless the app is away; scrolled up,
                            // it stays unread. Your own messages never count.
                            if (c.action == Action.Create && m.author != s.user?.id && (m.room != following || s.away) && m.id !in accounted) {
                                if (inFlight > 0) recent += m.room to m.id
                                store.update { it.bumpUnread(m.room) }
                            } else if (c.action == Action.Update && m.deleted && m.room in s.unread) refresh()
                        }
                }
            }
            // Mentioned, replied to or reacted to (or one taken back): the room's "@" and the inbox's count (DESIGN.md §41).
            r.sub { api.subscribeInbox { r.post { refresh() } } }
            r.sub {
                api.subscribeReads { c ->
                    r.post { if (c.record.room != following || store.get().away) refresh() }
                }
            }
            launch { api.connects.collect { reconnect -> if (reconnect) load(r) } }
            load(r)
        }
        r.defer(
            store.listen { st, prev ->
                if (!r.active) return@listen
                // A room you can now see (added to a private room, §23.2) may already have messages for you.
                if (prev.roomsStatus == LoadStatus.Ready && st.rooms !== prev.rooms && st.rooms.keys.any { it !in prev.rooms }) refresh()
                // Leaving the app: the open room may have messages that arrived unseen; what was read is sent first.
                if (st.away && !prev.away && st.activeRoomId != null) {
                    flush()
                    refresh()
                }
            },
        )
    }

    fun stop() {
        pending.clear()
        run?.dispose()
        run = null
    }

    private companion object {
        const val MAX_RETRY_MS = 60_000L
    }
}
