// One room's message window and everything that changes it (DESIGN.md §7.5, §7.6; ANDROID.md §6.3): a port of
// web/src/views/room/controller.ts. Loading (the kept window at once, then the first page in one round trip), realtime,
// reconnects and their gap fill here; sends (through the outbox), edits, deletes and reactions in RoomWrites.kt.
// No UI: the screen renders [state] and follows [scrolls]. Runs on the main thread; writes outlive the screen.
package chirkle.android.data.repo

import chirkle.android.data.api.Action
import chirkle.android.data.api.ApiError
import chirkle.android.data.api.ChirkleApi
import chirkle.android.data.lib.MessageOrder
import chirkle.android.data.lib.MessageWindow
import chirkle.android.data.lib.PAGE_SIZE
import chirkle.android.data.lib.PageKind
import chirkle.android.data.lib.Pages
import chirkle.android.data.lib.Side
import chirkle.android.data.lib.applyPage
import chirkle.android.data.lib.canPost
import chirkle.android.data.lib.lastOwnEditable
import chirkle.android.data.lib.lastSaved
import chirkle.android.data.lib.merge
import chirkle.android.data.lib.quote
import chirkle.android.data.lib.remove
import chirkle.android.data.lib.trim
import chirkle.android.data.model.Cursor
import chirkle.android.data.model.LocalFile
import chirkle.android.data.model.Message
import chirkle.android.data.model.MessageExpand
import chirkle.android.data.model.Quoted
import chirkle.android.data.model.Reaction
import chirkle.android.data.model.Room
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** How long a message gone to (a quote, a search result) stays highlighted. */
const val HIGHLIGHT_MS = 3000L
/** How long the line over the first unread message shows (§18.5). */
const val UNREAD_LINE_MS = 5000L

/** How many replies "Back to reply" remembers (DESIGN.md §19.5); the oldest go first. */
private const val BACK_MAX = 50

/** Loading until the first page is in; Failed offers Retry; NotFound: no such room (or not yours). */
enum class Phase { Loading, Ready, Failed, NotFound }

/** Below: new messages under what is on screen. History: new messages, but the window isn't at the live edge. */
enum class Pill { Below, History }

data class RoomState(
    /** What to show, oldest first: the window, and at the live edge the room's messages still in the outbox. */
    val items: List<Message> = emptyList(),
    val hasOlder: Boolean = false,
    val hasNewer: Boolean = false,
    val phase: Phase = Phase.Loading,
    /** The message gone to, highlighted for [HIGHLIGHT_MS]. */
    val targetId: String? = null,
    /** The first message that was unread when the room was opened: a line over it, for [UNREAD_LINE_MS]. */
    val unreadId: String? = null,
    val pill: Pill? = null,
    /**
     * The reply to go back to after following quotes (DESIGN.md §19.5): the last whose quote was followed, each step
     * back taking the one before. null: none, and the button offers "Jump to latest" as before.
     */
    val back: String? = null,
    /** Showing the room as it was last time until its first page is in. */
    val stale: Boolean = false,
    /** The kept window shows before the server said where the unread messages start: nothing counts as read yet. */
    val unsure: Boolean = false,
    /** The notice above the list ("" for none). */
    val notice: String = "",
    /** Reactions as they should show: the server's, with mine still on their way applied (§20.3). */
    val reacting: Map<String, Map<String, Boolean>> = emptyMap(),
)

/** What the list should do after a change. */
sealed interface Scroll {
    data object Bottom : Scroll
    data object Top : Scroll
    /** Bring the target (else the first unread message) into view. */
    data object Target : Scroll
    /** Content changed above what is on screen: keep it in place. */
    data object Anchor : Scroll
}

class RoomController(
    private val api: ChirkleApi,
    private val store: Store,
    private val outbox: Outbox,
    private val cache: RoomCache,
    private val tokens: FileTokens,
    val roomId: String,
    /** Open around this message (a link to it, a search result picked elsewhere). */
    private val msgId: String?,
    main: CoroutineDispatcher,
    /** Where writes run: they must reach the server even if the screen goes meanwhile. */
    private val writes: CoroutineScope,
) {
    private val run = Run(null, main)
    private val scope get() = run.scope
    private val stateFlow = MutableStateFlow(RoomState())
    /**
     * Kept until the screen collects them: the first one (to the first unread message) can come before the screen has
     * started to, and a lost one left the list at its newest rows, which then counted as read.
     */
    private val scrollFlow = Channel<Scroll>(16, BufferOverflow.DROP_OLDEST)

    val state: StateFlow<RoomState> = stateFlow.asStateFlow()
    val scrolls: Flow<Scroll> = scrollFlow.receiveAsFlow()
    val progress get() = outbox.progress

    /** Fetches of the room's messages out now ([tracked]). */
    private val fetching = MutableStateFlow(0)
    /** The room is being fetched (a first load, history, a jump, catching up after a reconnect): a line shows (§58). */
    val busy: Flow<Boolean> = fetching.map { it > 0 }.distinctUntilChanged()

    private suspend fun <T> tracked(block: suspend () -> T): T {
        fetching.update { it + 1 }
        try {
            return block()
        } finally {
            fetching.update { it - 1 }
        }
    }

    /** Is the list at (near) the bottom? Set by the screen; new messages are followed only then. */
    @Volatile var atBottom: Boolean = true

    private var win = MessageWindow()
    private var phase = Phase.Loading
    private var targetId: String? = null
    private var targetJob: Job? = null
    private var unreadId: String? = null
    private var pill: Pill? = null
    /** Replies whose quotes were followed, the last on top (DESIGN.md §19.5). */
    private val back = ArrayDeque<String>()
    private var notice = ""
    private var stale = false
    private var retarget = false
    private var asking = false
    private var wanted: Side? = null
    private var keepJob: Job? = null
    private var gen = 0
    private var buffer = mutableListOf<Pair<Action, Message>>()
    private val loading = mutableSetOf<Side>()
    private var live: Deferred<Unit> = CompletableDeferred(Unit)
    private var liveReady = false
    private val owner = store.get().user?.id.orEmpty()
    private val writer = RoomWrites(api, outbox, roomId, owner, writes, object : RoomWrites.Host {
        override val scope get() = this@RoomController.scope
        override var win
            get() = this@RoomController.win
            set(value) {
                this@RoomController.win = value
            }
        override fun me() = this@RoomController.me()
        override fun posting() = this@RoomController.posting()
        override fun editable(m: Message) = this@RoomController.editable(m)
        override fun deletable(m: Message) = this@RoomController.deletable(m)
        override fun reactable(m: Message) = this@RoomController.reactable(m)
        override fun find(id: String) = this@RoomController.find(id)
        override fun patchLocal(id: String, fn: (Message) -> Message) = this@RoomController.patchLocal(id, fn)
        override fun publish(scroll: Scroll?) = this@RoomController.publish(scroll)
        override fun inPlace() = this@RoomController.inPlace()
        override suspend fun toLatest() = tracked { jumpNow(PageKind.Latest) }
        override fun clearPill() {
            pill = null
        }
    })

    private val follows get() = atBottom && !store.get().away
    private val ready get() = phase == Phase.Ready
    private fun room(): Room? = store.get().rooms[roomId]
    private fun me() = store.get().user
    fun find(id: String): Message? = win.items.find { it.id == id }

    /** I may post here (§23.6): signed in, the room isn't archived, and it lets me. */
    fun posting(): Boolean {
        val r = room() ?: return false
        return !r.archived && r.canPost(me()?.id)
    }

    /**
     * Moderators delete anyone's messages outside DMs, even where they can't post (DESIGN.md §36); in a copy of another
     * instance's room, not that instance's people's: its home moderates them (§33.5).
     */
    private fun moderates(m: Message): Boolean {
        val r = room() ?: return false
        if (r.archived || me()?.moderator != true || r.isDm || m.author.isEmpty()) return false
        return !(r.shared?.home.orEmpty().isNotEmpty() && m.expand?.author?.instance.orEmpty().isNotEmpty())
    }

    fun deletable(m: Message) = !m.deleted && m.status == null && ((posting() && m.author == me()?.id) || moderates(m))
    fun editable(m: Message) = deletable(m) && posting() && m.author == me()?.id && m.forwardedFrom.isEmpty()

    /** Guests only read (§23.3): no replies, reactions or selecting. Readers who can't post still react (§23.6). */
    fun reactable(m: Message): Boolean {
        val r = room() ?: return false
        return me() != null && !r.archived && !m.deleted && m.status == null
    }

    fun repliable(m: Message) = reactable(m) && posting()
    fun selectable(m: Message) = me() != null && !m.deleted && m.status == null
    fun lastEditable(): Message? = win.lastOwnEditable(me()?.id.orEmpty())?.takeIf { editable(it) }

    // ---------------------------------------------------------------- state

    private fun publish(scroll: Scroll? = null) {
        if (!run.active) return
        val shown = if (win.hasNewer) win.items else {
            val queued = outbox.messages.value.filter { it.room == roomId && find(it.id) == null }
            if (queued.isEmpty()) win.items else (win.items + queued).sortedWith(MessageOrder)
        }
        stateFlow.value = RoomState(
            items = shown,
            hasOlder = win.hasOlder,
            hasNewer = win.hasNewer,
            phase = phase,
            targetId = targetId,
            unreadId = unreadId,
            pill = pill,
            back = back.lastOrNull(),
            stale = stale,
            unsure = stale && asking,
            notice = notice,
            reacting = writer.reactingNow(),
        )
        scroll?.let { scrollFlow.trySend(it) }
        keepJob?.cancel()
        keepJob = scope.launch {
            delay(1000)
            keep()
        }
    }

    /** Changed in place (an edit, a reaction, a delete): at the live bottom stay at the bottom, else keep what shows. */
    private fun inPlace(): Scroll = if (!win.hasNewer && atBottom) Scroll.Bottom else Scroll.Anchor

    /** Keep the latest page for next time: only a fresh window at the live edge, only for whom it was loaded. */
    private fun keep() {
        if ((me()?.id ?: "") != owner) return
        if (phase == Phase.NotFound || (room() == null && store.get().roomsStatus == LoadStatus.Ready)) {
            return cache.put(owner, roomId, Kept(emptyList(), false))
        }
        if (stale || !ready || win.hasNewer) return
        val saved = win.items.filter { it.status == null }
        val items = saved.takeLast(PAGE_SIZE)
        cache.put(owner, roomId, Kept(items, win.hasOlder || items.size < saved.size, room()))
    }

    private fun patchLocal(id: String, fn: (Message) -> Message) {
        win = win.copy(items = win.items.map { if (it.id == id) fn(it) else it })
    }

    private fun setTarget(id: String?) {
        targetId = id
        targetJob?.cancel()
        if (id == null) return
        targetJob = scope.launch {
            delay(HIGHLIGHT_MS)
            if (targetId == id) {
                targetId = null
                publish(Scroll.Anchor)
            }
        }
    }

    private fun setUnread(id: String?) {
        if (id == null || id == unreadId) return
        unreadId = id
        scope.launch {
            delay(UNREAD_LINE_MS)
            if (unreadId == id) {
                unreadId = null
                publish(Scroll.Anchor)
            }
        }
    }

    // ---------------------------------------------------------------- loading

    private fun applyLoaded(kind: PageKind, page: List<Message>, g: Int): Boolean {
        if (g != gen || !run.active) return false
        win = win.applyPage(page, kind).win
        return true
    }

    /** Extend the window at one end (the list neared it). One request per end at a time. */
    fun loadEdge(side: Side) {
        scope.launch { tracked { loadEdgeNow(side) } }
    }

    private suspend fun loadEdgeNow(side: Side) {
        val more = if (side == Side.Top) win.hasOlder else win.hasNewer
        if (stale) wanted = side
        if (!ready || stale || !more || side in loading || win.items.isEmpty()) return
        loading += side
        val g = gen
        try {
            val c = if (side == Side.Top) win.items.first() else win.items.last()
            val page = api.page(if (side == Side.Top) Pages.older(roomId, Cursor(c.created, c.id)) else Pages.newer(roomId, Cursor(c.created, c.id)))
            if (applyLoaded(if (side == Side.Top) PageKind.Older else PageKind.Newer, page, g)) publish(Scroll.Anchor)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // the list asks again as it scrolls
        } finally {
            if (g == gen) loading -= side
        }
    }

    /** Reset the window to the latest or the first page. */
    fun jump(kind: PageKind) {
        scope.launch { tracked { jumpNow(kind) } }
    }

    private suspend fun jumpNow(kind: PageKind) {
        val g = ++gen
        loading.clear()
        pill = null
        back.clear()
        publish()
        val page = runCatching { api.page(if (kind == PageKind.First) Pages.first(roomId) else Pages.latest(roomId)) }.getOrNull() ?: return
        if (!applyLoaded(kind, page, g)) return
        setTarget(null)
        notice = ""
        publish(if (kind == PageKind.First) Scroll.Top else Scroll.Bottom)
    }

    /**
     * Highlight and show message [id] (a reply's quote, a search result), loading the history around it when needed.
     * [from]: the reply whose quote was tapped, remembered to come back to (DESIGN.md §19.5) once the original shows.
     */
    fun goTo(id: String, from: String? = null) {
        scope.launch { tracked { goToNow(id, from) } }
    }

    /** Back to the reply whose quote was followed last ([RoomState.back]), and forget it (DESIGN.md §19.5). */
    fun goBack() {
        scope.launch {
            tracked {
                val id = back.removeLastOrNull() ?: return@tracked
                publish()
                goToNow(id)
            }
        }
    }

    private suspend fun goToNow(id: String, from: String? = null) {
        val remember = {
            if (from != null && back.lastOrNull() != from) {
                back.addLast(from)
                if (back.size > BACK_MAX) back.removeFirst()
            }
        }
        val m = find(id)
        if (m != null && m.status == null) {
            remember()
            setTarget(id)
            notice = ""
            return publish(Scroll.Target)
        }
        val g = gen
        val around = try {
            windowAround(id) ?: Around.Missing
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
        if (g != gen || !run.active) return
        if (around !is Around.Found) {
            notice = if (around == Around.Missing) "That message isn't available any more." else "Couldn't load that message. Check your connection."
            return publish()
        }
        gen++
        loading.clear()
        win = around.win
        remember()
        setTarget(around.target)
        pill = null
        notice = ""
        publish(Scroll.Target)
    }

    private sealed interface Around {
        data class Found(val win: MessageWindow, val target: String) : Around
        data object Missing : Around
    }

    /** The window around message [id], or null when it isn't in this room. Throws if a page fails. */
    private suspend fun windowAround(id: String): Around.Found? {
        val target = try {
            api.getMessage(id)
        } catch (e: ApiError) {
            if (e.status == 404) return null
            throw e
        }
        if (target.room != roomId) return null
        return Around.Found(windowAt(Cursor(target.created, target.id)), target.id)
    }

    /** The page before [c], and [c] with the page after it. */
    private suspend fun windowAt(c: Cursor): MessageWindow {
        val before = scope.async { api.page(Pages.older(roomId, c)) }
        val after = scope.async { api.page(Pages.newer(roomId, c.copy(id = ""))) }
        val b = before.await()
        val a = after.await()
        return MessageWindow(hasOlder = b.size >= PAGE_SIZE, hasNewer = a.size >= PAGE_SIZE).merge(b + a)
    }

    private class Loaded(val win: MessageWindow, val target: String?, val unread: String?)

    private suspend fun open() {
        val g = ++gen
        val roomP = scope.async { api.getRoom(roomId).also { r -> store.update { it.upsertRoom(r) } } }
        // Attachment URLs need a file token: have one before the first render, so images don't fail first.
        val tokenP = scope.async { runCatching { tokens.ensure() } }
        // With unread messages the room opens at the first of them (§18.5). Before the counts are in, only the server knows.
        val s = store.get()
        val askFirst = msgId == null && me() != null && (!s.counted || (s.unread[roomId] ?: 0) > 0)
        val firstP = if (askFirst) scope.async { runCatching { api.firstUnread(roomId) }.getOrNull() } else null
        val pageP = scope.async(start = CoroutineStart.LAZY) {
            val around = msgId?.let { windowAround(it) }
            if (around != null) return@async Loaded(around.win, around.target, null)
            // The latest page is asked for at once, beside the first unread message: with only a few unread, it has them.
            val latestP = scope.async { api.page(Pages.latest(roomId)) }
            val first = firstP?.await()
            val f = first?.id?.takeIf { it.isNotEmpty() }
            val page = if (f != null) runCatching { latestP.await() }.getOrDefault(emptyList()) else latestP.await()
            if (f != null && page.none { it.id == f }) return@async Loaded(windowAt(first), null, f)
            Loaded(MessageWindow().applyPage(page, PageKind.Latest).win, null, f)
        }
        pageP.start()
        if (msgId == null) scope.launch { showKept(g, roomP, firstP) }
        try {
            roomP.await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (!run.active) return
            phase = if (e is ApiError && e.status == 404) Phase.NotFound else Phase.Failed
            stale = false
            if (phase == Phase.NotFound && me() != null) api.suspectSession()
            return publish()
        }
        val loaded = try {
            pageP.await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
        tokenP.await()
        if (!run.active) return
        val current = g == gen
        if (current && loaded == null) {
            // Never show a failed load as an empty room: say so and offer Retry.
            phase = Phase.Failed
            stale = false
            return publish()
        }
        var scroll: Scroll? = null
        if (current && loaded != null) {
            // What was sent, edited or reacted to while the kept window showed is newer than the page (QA BUG-100).
            val a = loaded.win.items.firstOrNull()
            val z = loaded.win.items.lastOrNull()
            val meanwhile = win.items.filter { m ->
                m.status == null && (a == null || MessageOrder.compare(m, a) >= 0) && (!loaded.win.hasNewer || MessageOrder.compare(m, z!!) <= 0)
            }
            win = loaded.win.merge(meanwhile).merge(loaded.win.items)
            setTarget(loaded.target)
            setUnread(loaded.unread)
            notice = if (msgId != null && loaded.target == null) "That message isn't in this room. Showing the latest messages instead." else ""
            // A stale window was already shown at the first unread message, or scrolled: stay there (QA BUG-96).
            scroll = when {
                targetId != null || !stale || retarget -> if (targetId != null || loaded.unread != null) Scroll.Target else Scroll.Bottom
                atBottom && loaded.unread == null -> Scroll.Bottom
                else -> Scroll.Anchor
            }
        }
        phase = Phase.Ready
        stale = false
        publish(scroll)
        wanted?.let { loadEdgeNow(it) }
        val pending = buffer
        buffer = mutableListOf()
        for ((action, m) in pending) onMessage(action, m)
        // A message sent after the page was read but before the server had the subscription reaches neither (QA BUG-61).
        if (!liveReady) scope.launch {
            live.await()
            tracked { catchUp() }
        }
    }

    /** Show the room as it was last time while its first page loads (§7.5). */
    private suspend fun showKept(g: Int, roomP: Deferred<Room>, firstP: Deferred<Cursor?>?) {
        val kept = cache.peek(owner, roomId) ?: cache.get(owner, roomId)
        if (kept?.items?.any { it.files.isNotEmpty() } == true) runCatching { tokens.ensure() }
        if (room() == null && kept?.room != null && store.get().roomsStatus != LoadStatus.Ready) store.update { it.upsertRoom(kept.room) }
        if (room() == null) runCatching { roomP.await() }
        if (kept == null || kept.items.isEmpty() || g != gen || phase != Phase.Loading || room() == null || !run.active) return
        val shown = MessageWindow(hasOlder = kept.hasOlder).merge(kept.items)
        // Opening at the first unread message (§18.5): the count says which one, if they were all prefetched with it.
        val s = store.get()
        val n = if (firstP != null && s.counted) s.unread[roomId] ?: 0 else 0
        val theirs = shown.items.filter { it.author != owner && !it.deleted }
        val guess = if (n > 0) theirs.getOrNull(theirs.size - n) else null
        if (n > 0 && (guess == null || kept.unread != n)) return
        win = shown
        setUnread(guess?.id)
        asking = firstP != null && guess == null
        stale = true
        phase = Phase.Ready
        publish(if (guess != null) Scroll.Target else Scroll.Bottom)
        val f = firstP?.await()?.id?.takeIf { it.isNotEmpty() }
        val asked = asking
        asking = false
        if (g != gen || !stale || !run.active) return
        if (f == null || f == unreadId) {
            if (asked) publish(Scroll.Anchor) // read now
            return
        }
        // Shown at the bottom (or the count was out of step): go where the server says, unless scrolled away.
        val follow = guess != null || atBottom
        if (find(f) == null) retarget = follow
        else {
            setUnread(f)
            publish(if (follow) Scroll.Target else Scroll.Anchor)
        }
    }

    /** Messages newer than the window's that realtime may have missed while it was being set up (QA BUG-61). */
    private suspend fun catchUp() {
        if (!run.active || !ready || win.hasNewer) return
        val g = gen
        val last = win.lastSaved()
        val page = runCatching { api.page(if (last != null) Pages.newer(roomId, Cursor(last.created, last.id)) else Pages.latest(roomId)) }.getOrNull() ?: return
        if (g != gen || !run.active || win.hasNewer) return
        if (page.none { find(it.id) == null }) return
        val follow = follows
        win = win.applyPage(page, if (last != null) PageKind.Newer else PageKind.Latest).win
        if (!follow) pill = Pill.Below
        publish(if (follow) Scroll.Bottom else Scroll.Anchor)
    }

    /** Retry a failed first load. */
    fun retry() {
        if (phase != Phase.Failed || !run.active) return
        phase = Phase.Loading
        publish()
        scope.launch { tracked { open() } }
    }

    /** After a reconnect: refetch what changed in the window while realtime was down (a delete must not keep its text). */
    private suspend fun refreshWindow() {
        val g = gen
        val known = win.items.filter { it.status == null }
        val oldest = known.firstOrNull() ?: return
        val newest = known.last()
        val since = known.maxOf { it.updated }
        val changed = runCatching { api.changes(Pages.changedIn(roomId, since, Cursor(oldest.created, oldest.id), Cursor(newest.created, newest.id))) }.getOrNull() ?: return
        if (g != gen || !run.active) return
        val inWindow = changed.filter { find(it.id) != null }
        if (inWindow.isEmpty()) return
        win = win.merge(inWindow)
        publish(inPlace())
    }

    /** At the live edge after a reconnect: fetch everything newer than what we have. */
    private suspend fun gapFill() {
        val g = gen
        val wasNear = follows
        while (true) {
            val last = win.lastSaved()
            val page = runCatching { api.page(if (last != null) Pages.newer(roomId, Cursor(last.created, last.id)) else Pages.latest(roomId)) }.getOrNull() ?: return
            if (g != gen || !run.active) return
            win = win.applyPage(page, if (last != null) PageKind.Newer else PageKind.Latest).win
            if (page.size < PAGE_SIZE) break
        }
        win = win.copy(hasNewer = false)
        publish(if (wasNear) Scroll.Bottom else Scroll.Anchor)
    }

    private fun onReconnect() {
        if (!run.active) return
        if (phase == Phase.Failed) return retry()
        if (!ready || stale) return
        scope.launch { tracked { refreshWindow() } }
        if (!win.hasNewer) scope.launch { tracked { gapFill() } }
    }

    // ---------------------------------------------------------------- realtime

    /** Quotes being fetched, by the id of the message quoted. */
    private val quoting = mutableSetOf<String>()

    /**
     * Live events come without the message a reply answers (ChirkleApi LIVE_OPTS): the quote is the copy in the window,
     * or the one the message had there; failing both (a reply to a message far back), it is fetched.
     */
    private fun quoted(m: Message): Message {
        if (m.replyTo.isEmpty() || m.expand?.replyTo != null) return m
        val q = find(m.replyTo)?.quote() ?: find(m.id)?.expand?.replyTo
        if (q != null) return m.withQuote(q)
        fetchQuote(m.replyTo)
        return m
    }

    private fun Message.withQuote(q: Quoted) = copy(expand = (expand ?: MessageExpand()).copy(replyTo = q))

    private fun fetchQuote(id: String) {
        if (!quoting.add(id)) return
        scope.launch {
            val q = try {
                api.getMessage(id).quote()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null
            } finally {
                quoting.remove(id)
            }
            if (q == null || !run.active) return@launch
            win = win.copy(items = win.items.map { if (it.replyTo == id && it.expand?.replyTo == null) it.withQuote(q) else it })
            publish(inPlace())
        }
    }

    private fun onMessage(action: Action, event: Message) {
        if (!run.active || event.room != roomId) return
        if (!ready || stale) buffer += action to event // the first page may be older than this event
        if (!ready) return
        val m = if (action == Action.Delete) event else quoted(event)
        when (action) {
            Action.Delete -> {
                win = win.remove(m.id)
                publish(inPlace())
            }
            Action.Update -> {
                if (find(m.id) == null) return
                win = win.merge(listOf(m))
                publish(inPlace())
            }
            Action.Create -> {
                if (find(m.id) != null) {
                    win = win.merge(listOf(m))
                    return publish()
                }
                if (win.hasNewer) {
                    pill = Pill.History
                    return publish()
                }
                val follow = !store.get().away && (atBottom || m.author == me()?.id)
                win = win.merge(listOf(m)).trim(Side.Top).win
                if (!follow && pill != Pill.History) pill = Pill.Below
                publish(if (follow) Scroll.Bottom else Scroll.Anchor)
            }
        }
    }

    // ---------------------------------------------------------------- writes (RoomWrites.kt)

    /**
     * Send optimistically, as a reply to [replyTo] if given (§19). [files] are already in app storage (the outbox
     * deletes them once sent). False when sending isn't possible (no user, archived, not allowed to post: §23.6).
     */
    fun send(text: String, files: List<LocalFile> = emptyList(), replyTo: Message? = null, items: List<chirkle.android.data.model.CollectionItem> = emptyList()): Boolean =
        writer.send(text, files, replyTo, items)

    fun retrySend(id: String) = writer.retrySend(id)

    fun discard(id: String) = writer.discard(id)

    /** Save validated text. Null: nothing to save (unchanged, or no longer editable). */
    fun edit(id: String, text: String): Deferred<Boolean>? = writer.edit(id, text)

    /** Soft delete. Null: not in the window. */
    fun remove(id: String): Deferred<Boolean>? = writer.remove(id)

    /** Soft-delete several messages in one request, all or none (§21.2). Null: none deletable. Resolves to the error, or null. */
    fun removeMany(ids: List<String>): Deferred<Throwable?>? = writer.removeMany(ids)

    /** A message's reactions as they should show: the server's, with my changes on their way applied. */
    fun reactions(m: Message): List<Reaction> = writer.reactions(m)

    /**
     * Add ([on]) or remove my [emoji], shown at once. Null when not possible. Resolves null once it is in, else why not
     * ("" when the server wasn't reached).
     */
    fun react(id: String, emoji: String, on: Boolean): Deferred<String?>? = writer.react(id, emoji, on)

    /**
     * The list is at the bottom now: hide the "new messages below" pill, and, at the live edge, forget the replies to go
     * back to (DESIGN.md §19.5): nothing is needed to come back to the latest messages.
     */
    fun dismissPill() {
        val forget = back.isNotEmpty() && !win.hasNewer
        if (pill != Pill.Below && !forget) return
        if (pill == Pill.Below) pill = null
        if (forget) back.clear()
        publish()
    }

    // ---------------------------------------------------------------- lifecycle

    fun start() {
        run.defer {
            keepJob?.cancel()
            keep()
        }
        // Keep a fresh file token for attachment URLs (§17.3); it only fetches when the cached one is old.
        scope.launch {
            while (true) {
                delay(30_000)
                runCatching { tokens.ensure() }
            }
        }
        live = scope.async {
            val off = api.subscribeMessages(roomId) { c -> run.post { onMessage(c.action, c.record) } }
            run.defer { Run.cleanup(off) }
            liveReady = true
        }
        scope.launch { api.connects.collect { reconnect -> if (reconnect) onReconnect() } }
        // The outbox's messages for this room show at the live edge; those it sent join the window.
        scope.launch { outbox.messages.collect { publish() } }
        scope.launch {
            outbox.saved.collect { m ->
                if (m.room == roomId && find(m.id) == null && !win.hasNewer) win = win.merge(listOf(m))
                else if (m.room == roomId && find(m.id) != null) win = win.merge(listOf(m))
                publish()
            }
        }
        // The room record (archived, access) arrives through the store, kept live by RoomsSync.
        scope.launch { store.flow.collect { if (ready) publish() } }
        scope.launch { tracked { open() } }
    }

    /** The screen is gone: keep the window for next time, unsubscribe. Writes on their way go on. */
    fun close() = run.dispose()
}
