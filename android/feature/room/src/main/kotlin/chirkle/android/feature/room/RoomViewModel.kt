// One room screen's state (ANDROID.md §7): the controller's window as list rows, the composer (draft, reply, edit,
// attachments), selection (§21), search (§29) and what has been read (§18.3).
package chirkle.android.feature.room

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import chirkle.android.data.api.reasonOf
import chirkle.android.data.lib.Limits
import chirkle.android.data.lib.MessageOrder
import chirkle.android.data.lib.PAGE_SIZE
import chirkle.android.data.lib.Pages
import chirkle.android.data.lib.checkFiles
import chirkle.android.data.lib.isBlank
import chirkle.android.data.lib.isForeignContent
import chirkle.android.data.lib.otherMember
import chirkle.android.data.lib.quote
import chirkle.android.data.lib.searchQuery
import chirkle.android.data.lib.searchWords
import chirkle.android.data.lib.startsGroup
import chirkle.android.data.lib.textLength
import chirkle.android.data.model.Cursor
import chirkle.android.data.model.LocalFile
import chirkle.android.data.model.Message
import chirkle.android.data.repo.ChirkleServices
import chirkle.android.data.repo.RoomController
import chirkle.android.data.repo.RoomReader
import chirkle.android.data.repo.RoomState
import chirkle.android.ui.Formats
import chirkle.android.ui.ImagePrep
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

/** How long typing pauses before the server is asked who an "@" may name (DESIGN.md §41; the web waits as long). */
private const val MENTION_WAIT_MS = 120L

/** A row of the message list, newest first (the list is laid out from the bottom). */
sealed interface ListRow {
    val key: String

    data class Msg(val m: Message, val first: Boolean, val target: Boolean) : ListRow {
        override val key get() = m.id
    }

    data class Day(val label: String, override val key: String) : ListRow

    /** The line over the first message that was unread (§18.5). */
    data object NewLine : ListRow {
        override val key = "new-line"
    }

    /** The start of the room's history. */
    data class Beginning(val text: String) : ListRow {
        override val key = "beginning"
    }
}

class RoomViewModel(
    private val app: Application,
    val services: ChirkleServices,
    val roomId: String,
    msgId: String?,
) : ViewModel() {
    val controller: RoomController = services.openRoom(roomId, msgId)
    private val reader: RoomReader? = if (services.store.get().user != null) services.unread.open(roomId) else null
    private val me get() = services.store.get().user?.id.orEmpty()

    /** The list's rows, newest first, built off the composition. */
    val rows: StateFlow<List<ListRow>> = controller.state.map { s -> buildRows(s) }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    // ---- composer (§7.2, §22.3)

    var text by mutableStateOf(TextFieldValue(""))
        private set
    var replyTo by mutableStateOf<Message?>(null)
        private set
    var editing by mutableStateOf<Message?>(null)
        private set
    var attachments by mutableStateOf<List<LocalFile>>(emptyList())
        private set
    /** Videos being compressed for the tray (VideoPrep), in turn; the message waits for them. */
    var preparing by mutableStateOf<List<Preparing>>(emptyList())
        private set
    /** Collection items picked to attach (DESIGN.md §31.3): sent after the files, as the server attaches them. */
    var items by mutableStateOf<List<chirkle.android.data.model.CollectionItem>>(emptyList())
        private set
    /** What the "from collection" badges of the room's files say (§31.3), asked once while the room is open. */
    val badges = chirkle.android.data.repo.Badges(services.api, viewModelScope)
    /** A problem with what is being written ("" for none). */
    var composerError by mutableStateOf("")
        private set
    /** A passing message (a failed reaction, forward, delete): shown once. */
    var toast by mutableStateOf<String?>(null)
    private var draftJob: Job? = null
    private var savedText: TextFieldValue? = null

    init {
        services.opened.note(roomId)
        // The reply and the edit follow their message: edited, the bar shows the new text; deleted (or no longer
        // allowed), there is nothing left to reply to or edit (DESIGN.md §19.3, the web's reply.ts; QA BUG-182). The
        // room too: archived, the reply ends, and doesn't come back unarchived.
        viewModelScope.launch { controller.state.collect { follow() } }
        viewModelScope.launch { services.store.flow.collect { follow() } }
        viewModelScope.launch {
            val d = services.drafts.get(me, roomId) ?: return@launch
            if (text.text.isEmpty()) text = TextFieldValue(d.text, TextRange(d.text.length))
            if (d.replyTo.isNotEmpty()) waitForReply(d.replyTo)
        }
    }

    private fun follow() {
        replyTo?.let { r ->
            val now = controller.find(r.id) ?: r
            if (!controller.repliable(now)) cancelReply() else if (now != r) replyTo = now
        }
        editing?.let { m ->
            val now = controller.find(m.id) ?: m
            if (!controller.editable(now)) cancelEdit() else if (now != m) editing = now
        }
    }

    /** The draft's reply target, once the window has it. */
    private suspend fun waitForReply(id: String) {
        repeat(50) {
            controller.find(id)?.let { if (replyTo == null && editing == null) replyTo = it; return }
            delay(100)
        }
    }

    fun onText(v: TextFieldValue) {
        // A whole ":name:" just typed becomes its emoji (DESIGN.md §20.6): when the text grew (a keyboard may commit more
        // than one character at a time), not when the caret moves next to one.
        val caret = v.selection.end
        val whole = if (v.selection.collapsed && v.text.length > text.text.length) chirkle.android.data.lib.wholeEmojiName(v.text, caret) else null
        text = whole?.let { (at, e) -> services.recentEmoji.remember(e); TextFieldValue(v.text.substring(0, at) + e + v.text.substring(caret), TextRange(at + e.length)) } ?: v
        composerError = ""
        if (editing == null) saveDraft()
        suggest()
    }

    /** Emoji offered for the ":name" before the caret (DESIGN.md §20.6), and the one chosen. */
    var suggestions by mutableStateOf<List<chirkle.android.data.lib.NamedEmoji>>(emptyList())
        private set
    var suggestion by mutableStateOf(0)
        private set
    private var suggestAt = -1
    /** Where the ":name" closed with Escape starts: not offered again until another one is typed. */
    private var dismissedAt = -1

    /**
     * People offered for the "@an" before the caret (DESIGN.md §41, GET /api/chat/mentionable; just "@": who wrote here
     * lately), asked once typing pauses. Shown instead of emoji: the two never start at once.
     */
    var people by mutableStateOf<List<chirkle.android.data.model.Mentionable>>(emptyList())
        private set
    private var peopleAt = -1
    private var peopleDismissed = -1
    private var peopleJob: Job? = null

    private fun suggestPeople() {
        val t = if (text.selection.collapsed) chirkle.android.data.lib.mentionToken(text.text, text.selection.end) else null
        if (t == null) peopleDismissed = -1
        peopleJob?.cancel()
        if (t == null || t.start == peopleDismissed) {
            peopleAt = -1
            people = emptyList()
            return
        }
        peopleJob = viewModelScope.launch {
            delay(MENTION_WAIT_MS)
            val found = runCatching { services.api.mentionable(roomId, t.query) }.getOrNull() ?: return@launch
            // The text may have moved on meanwhile.
            val now = if (text.selection.collapsed) chirkle.android.data.lib.mentionToken(text.text, text.selection.end) else null
            if (now != t) return@launch
            if (t.start != peopleAt) suggestion = 0
            peopleAt = if (found.isEmpty()) -1 else t.start
            people = found
            if (found.isNotEmpty()) suggestion = suggestion.coerceAtMost(found.lastIndex)
        }
    }

    private fun suggest() {
        suggestPeople()
        val t = if (text.selection.collapsed) chirkle.android.data.lib.emojiToken(text.text, text.selection.end) else null
        if (t == null) dismissedAt = -1
        val found = if (t == null || t.start == dismissedAt) emptyList() else chirkle.android.data.lib.findEmoji(t.query, chirkle.android.data.lib.SUGGEST_MAX)
        if (found.isEmpty()) {
            suggestAt = -1
            suggestions = emptyList()
            return
        }
        if (t!!.start != suggestAt) suggestion = 0
        suggestAt = t.start
        suggestions = found
        suggestion = suggestion.coerceAtMost(found.lastIndex)
    }

    /** ↑/↓ with a hardware keyboard: round the list. */
    fun stepSuggestion(by: Int) {
        if (people.isNotEmpty()) suggestion = (suggestion + by).mod(people.size)
        else if (suggestions.isNotEmpty()) suggestion = (suggestion + by).mod(suggestions.size)
    }

    fun dismissSuggestions() {
        if (people.isNotEmpty()) peopleDismissed = peopleAt else dismissedAt = suggestAt
        suggest()
    }

    /** Emoji or people are offered over the composer. */
    val suggesting: Boolean get() = people.isNotEmpty() || suggestions.isNotEmpty()

    /** Put the person's "@handle " in place of "@an" (and the rest of a handle typed after the caret). */
    fun pickPerson(i: Int = suggestion) {
        val u = people.getOrNull(i) ?: return
        val t = text
        val caret = t.selection.end
        val tail = Regex("^\\w*").find(t.text.substring(caret))?.value?.length ?: 0
        val put = "@${u.handle} "
        val at = peopleAt
        people = emptyList()
        peopleAt = -1
        onText(TextFieldValue(t.text.substring(0, at) + put + t.text.substring(caret + tail), TextRange(at + put.length)))
    }

    /** Put the emoji in place of ":name", with a space after when it ends the text. */
    fun pickSuggestion(i: Int = suggestion) {
        if (people.isNotEmpty()) return pickPerson(i)
        val e = suggestions.getOrNull(i)?.emoji ?: return
        val t = text
        val caret = t.selection.end
        val put = e + if (caret == t.text.length) " " else ""
        services.recentEmoji.remember(e)
        onText(TextFieldValue(t.text.substring(0, suggestAt) + put + t.text.substring(caret), TextRange(suggestAt + put.length)))
    }

    private fun saveDraft() {
        draftJob?.cancel()
        draftJob = viewModelScope.launch {
            delay(300)
            services.drafts.set(me, roomId, text.text, replyTo?.id.orEmpty())
        }
    }

    fun insert(emoji: String) {
        val t = text
        val start = minOf(t.selection.start, t.selection.end)
        val end = maxOf(t.selection.start, t.selection.end)
        onText(TextFieldValue(t.text.substring(0, start) + emoji + t.text.substring(end), TextRange(start + emoji.length)))
    }

    fun reply(m: Message) {
        if (!controller.repliable(m)) return
        if (editing != null) cancelEdit()
        replyTo = m
        saveDraft()
    }

    fun cancelReply() {
        replyTo = null
        saveDraft()
    }

    fun startEdit(m: Message) {
        if (!controller.editable(m)) return
        if (editing == null) savedText = text
        replyTo = null
        editing = m
        text = TextFieldValue(m.text, TextRange(m.text.length))
        composerError = ""
    }

    fun cancelEdit() {
        editing = null
        text = savedText ?: TextFieldValue("")
        savedText = null
        composerError = ""
    }

    /** Edit my newest message (Up in an empty composer, as on the web). */
    fun editLast(): Boolean {
        if (text.text.isNotEmpty() || editing != null) return false
        controller.lastEditable()?.let { startEdit(it); return true }
        return false
    }

    /** Pick the message above or below the one replied to (Ctrl+Up/Down, as on the web). */
    fun moveReply(up: Boolean) {
        val items = controller.state.value.items.filter { controller.repliable(it) }
        if (items.isEmpty()) return
        val i = replyTo?.let { r -> items.indexOfFirst { it.id == r.id } } ?: -1
        val next = when {
            i < 0 -> if (up) items.last() else null
            up -> items.getOrNull(i - 1) ?: items[i]
            else -> items.getOrNull(i + 1)
        }
        if (next == null) cancelReply() else reply(next)
    }

    private fun tooLong(s: String): String? {
        val n = textLength(s)
        return if (n > Limits.MESSAGE_TEXT) "Too long: ${n - Limits.MESSAGE_TEXT} characters over the ${Limits.MESSAGE_TEXT} limit." else null
    }

    /** Send what is written (or save the edit). */
    fun submit() {
        val body = text.text
        editing?.let { m ->
            if (isBlank(body)) return run { composerError = "A message can't be empty. Use Delete to remove it." }
            tooLong(body)?.let { return run { composerError = it } }
            val saved = controller.edit(m.id, body.trim())
            cancelEdit()
            viewModelScope.launch { if (saved?.await() == false) toast = "Couldn't save your edit." }
            return
        }
        if (preparing.isNotEmpty()) return
        if (isBlank(body) && attachments.isEmpty() && items.isEmpty()) return
        tooLong(body)?.let { return run { composerError = it } }
        if (!controller.send(body.trim(), attachments, replyTo, items)) return
        text = TextFieldValue("")
        attachments = emptyList()
        items = emptyList()
        replyTo = null
        draftJob?.cancel()
        services.drafts.set(me, roomId, "", "")
    }

    /** Picked files: copied into app storage (the outbox sends them from there, even after a restart). */
    fun attach(uris: List<Uri>) {
        viewModelScope.launch {
            val dir = File(app.filesDir, "outbox/${services.accountId}/${UUID.randomUUID()}").apply { mkdirs() }
            val all = withContext(Dispatchers.IO) { uris.mapNotNull { describe(it) } }
            // Videos are compressed first (VideoPrep), so a bigger one than the limit may still go.
            val (videos, others) = all.partition { it.type.startsWith("video/") && it.size in 0..VideoPrep.MAX_SOURCE_BYTES }
            val rejected = mutableListOf<Pair<String, String>>()
            val room = filesLeft
            for ((i, v) in videos.withIndex()) {
                if (i < room) prepareVideo(v, dir) else rejected += v.name to "at most ${Limits.ATTACHMENTS} files per message"
            }
            val picked = withContext(Dispatchers.IO) { others.mapNotNull { copy(it, dir) } }
            val check = checkFiles(attachments.size + items.size + preparing.size, picked, { it.name }, { it.size })
            for (f in picked - check.accepted.toSet()) File(f.uri).delete()
            attachments = attachments + check.accepted
            composerError = (rejected + check.rejected).joinToString(" ") { (name, why) -> "“$name” wasn't added: $why." }
        }
    }

    /** A video in the tray while it is compressed: [progress] is 0..100, or -1 while it waits for the one before. */
    data class Preparing(val id: String, val name: String, val progress: Int = -1)

    private val preparingJobs = mutableMapOf<String, Job>()
    private val videoLock = Mutex()

    private fun prepareVideo(v: Picked, dir: File) {
        val p = Preparing(UUID.randomUUID().toString(), v.name)
        preparing = preparing + p
        fun progress(n: Int) {
            preparing = preparing.map { if (it.id == p.id) it.copy(progress = n) else it }
        }
        preparingJobs[p.id] = viewModelScope.launch {
            try {
                val result = videoLock.withLock {
                    progress(0)
                    VideoPrep.prepare(app, v.uri, v.name, v.size, File(dir, "prepared-${p.id}.mp4"), ::progress)
                }
                val file = when (result) {
                    is VideoPrep.Result.Done -> LocalFile(result.file.path, result.name, "video/mp4", result.file.length())
                    // Not readable as a video here: sent as it is, as before.
                    VideoPrep.Result.Failed -> withContext(Dispatchers.IO) { copy(v, dir) }
                    VideoPrep.Result.TooLong -> null
                }
                preparing = preparing - p
                if (file == null) {
                    composerError = "“${v.name}” wasn't added: too long to send (about ${VideoPrep.maxMinutes()} minutes at most)."
                    return@launch
                }
                val check = checkFiles(attachments.size + items.size + preparing.size, listOf(file), { it.name }, { it.size })
                if (check.accepted.isEmpty()) File(file.uri).delete()
                attachments = attachments + check.accepted
                composerError = check.rejected.joinToString(" ") { (name, why) -> "“$name” wasn't added: $why." }
            } finally {
                preparing = preparing - p
                preparingJobs.remove(p.id)
            }
        }
    }

    /** × on a video being compressed: it stops and leaves the tray. */
    fun cancelPreparing(p: Preparing) {
        preparingJobs[p.id]?.cancel()
    }

    /** How many more files the message takes. */
    val filesLeft: Int get() = (Limits.ATTACHMENTS - attachments.size - items.size - preparing.size).coerceAtLeast(0)

    /** Items picked from a collection join the tray (each once, as many as the message still takes). */
    fun attachItems(picked: List<chirkle.android.data.model.CollectionItem>) {
        val have = items.map { it.id }.toSet()
        items = items + picked.filter { it.id !in have }.take(filesLeft)
        composerError = ""
    }

    fun removeItem(it: chirkle.android.data.model.CollectionItem) {
        items = items - it
    }

    fun removeAttachment(f: LocalFile) {
        attachments = attachments - f
        File(f.uri).delete()
    }

    /** A picked file: its name, type and size (-1 when unknown). */
    private class Picked(val uri: Uri, val name: String, val type: String, val size: Long)

    private fun describe(uri: Uri): Picked? = runCatching {
        if (!isForeignContent(uri.scheme, uri.authority, app.packageName)) return null
        val cr = app.contentResolver
        var name = "file"
        var size = -1L
        cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                name = c.getString(0) ?: name
                if (!c.isNull(1)) size = c.getLong(1)
            }
        }
        Picked(uri, name, cr.getType(uri) ?: "application/octet-stream", size)
    }.getOrNull()

    private fun copy(p: Picked, dir: File): LocalFile? = runCatching {
        val uri = p.uri
        val name = p.name
        val type = p.type
        val size = p.size
        val cr = app.contentResolver
        // Too big to send: not copied at all.
        if (size > Limits.ATTACHMENT_BYTES) return LocalFile("", name, type, size)
        val safe = name.replace(Regex("[/\\\\\u0000]"), "_").ifBlank { "file" }
        val out = generateSequence(File(dir, safe)) { File(dir, "${it.nameWithoutExtension}-1.${it.extension}") }.first { !it.exists() }
        cr.openInputStream(uri)!!.use { input -> out.outputStream().use { input.copyTo(it) } }
        // Photos are scaled down and re-encoded, which drops their EXIF (GPS location, §15.3).
        ImagePrep.prepare(out, name, type, ImagePrep.ATTACHMENT_EDGE)?.let { (file, n, t) ->
            out.delete()
            return LocalFile(file.path, n, t, file.length())
        }
        LocalFile(out.path, name, type, out.length())
    }.getOrNull()

    // ---- selection (§21)

    var selected by mutableStateOf<Set<String>>(emptySet())
        private set
    val selecting get() = selected.isNotEmpty()

    fun toggleSelect(m: Message) {
        if (!controller.selectable(m)) return
        selected = when {
            m.id in selected -> selected - m.id
            selected.size >= Limits.MAX_SELECTED -> {
                toast = "You can select up to ${Limits.MAX_SELECTED} messages at a time."
                selected
            }
            else -> selected + m.id
        }
    }

    fun clearSelection() {
        selected = emptySet()
    }

    /** Can every selected message be deleted by me? */
    val canDeleteSelected: Boolean get() = selected.isNotEmpty() && selected.all { id -> controller.find(id)?.let { controller.deletable(it) } == true }

    fun deleteSelected() {
        val ids = selected.toList()
        val done = controller.removeMany(ids) ?: return
        selected = emptySet()
        viewModelScope.launch { done.await()?.let { toast = "Couldn't delete those messages. ${reasonOf(it)}" } }
    }

    /** Forward [ids] into [room] (§21.3); the copies are mine and say who first wrote them. */
    fun forward(ids: List<String>, to: ForwardTo, then: (String) -> Unit = {}) {
        val ordered = ids.mapNotNull { controller.find(it) }.sortedWith(MessageOrder).map { it.id }
        viewModelScope.launch {
            // Someone you had no DM with: open it first, as the web does (§16.2).
            var room = ""
            runCatching {
                room = when (to) { is ForwardTo.ToRoom -> to.room.id; is ForwardTo.ToUser -> services.actions.openDm(to.user.id).id }
                services.api.forward(ordered, room)
            }
                .onSuccess {
                    selected = emptySet()
                    toast = if (ordered.size == 1) "Message forwarded." else "${ordered.size} messages forwarded."
                    then(room)
                }
                .onFailure { toast = "Couldn't forward. ${reasonOf(it)}" }
        }
    }

    // ---- reactions (§20)

    fun react(m: Message, emoji: String) {
        val mine = controller.reactions(m).any { it.emoji == emoji && me in it.users }
        val done = controller.react(m.id, emoji, !mine) ?: return
        viewModelScope.launch {
            val failure = done.await() ?: return@launch
            toast = failure.ifEmpty { if (mine) "Couldn't remove your $emoji reaction." else "Couldn't add your $emoji reaction." }
        }
        services.recentEmoji.remember(emoji)
    }

    fun delete(m: Message) {
        val done = controller.remove(m.id) ?: return
        viewModelScope.launch { if (!done.await()) toast = "Couldn't delete this message." }
    }

    /** A moderator's Ban or Unban (DESIGN.md §36). */
    fun setBanned(user: String, banned: Boolean) {
        viewModelScope.launch {
            toast = runCatching { services.api.setBanned(user, banned) }.fold(
                { if (banned) "Banned. They can't sign in until unbanned." else "Unbanned." },
                { "Couldn't ${if (banned) "ban" else "unban"} them. ${chirkle.android.data.api.errorMessage(it)}" },
            )
        }
    }

    // ---- search (§29)

    var searching by mutableStateOf(false)
        private set
    var query by mutableStateOf("")
        private set
    var results by mutableStateOf<List<Message>>(emptyList())
        private set
    var searchStatus by mutableStateOf("")
        private set
    var moreResults by mutableStateOf(false)
        private set
    /** The results are over the list; picking one puts them away, until the field is used again. */
    var resultsShown by mutableStateOf(true)
        private set

    fun showResults() {
        resultsShown = true
    }
    private var searchJob: Job? = null
    // State, so a narrower query that finds the same messages still moves the highlight.
    private var words: List<String> by mutableStateOf(emptyList())

    fun openSearch() {
        searching = true
    }

    fun closeSearch() {
        searching = false
        searchJob?.cancel()
        query = ""
        results = emptyList()
        searchStatus = ""
        words = emptyList()
    }

    fun onQuery(q: String) {
        if (q != query) resultsShown = true
        query = q
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            delay(300)
            runSearch(false)
        }
    }

    fun searchNow() {
        resultsShown = true
        searchJob?.cancel()
        searchJob = viewModelScope.launch { runSearch(false) }
    }

    fun searchMore() {
        searchJob?.cancel()
        searchJob = viewModelScope.launch { runSearch(true) }
    }

    private suspend fun runSearch(next: Boolean) {
        val w = if (next) words else searchWords(query)
        if (!next && w == words && results.isNotEmpty()) return
        if (w.isEmpty()) {
            words = emptyList()
            results = emptyList()
            searchStatus = ""
            moreResults = false
            return
        }
        if (!next) words = w
        searchStatus = "Searching…"
        val before = if (next) results.lastOrNull()?.let { Cursor(it.created, it.id) } else null
        val page = runCatching { services.api.page(searchQuery(roomId, w, before)) }.getOrNull()
        if (page == null) {
            searchStatus = "Couldn't search. Check your connection."
            return
        }
        results = if (next) results + page else page
        moreResults = page.size >= PAGE_SIZE
        val n = results.size
        searchStatus = if (n == 0) "No messages found." else "$n${if (moreResults) "+" else ""} ${if (n == 1) "message" else "messages"} found."
    }

    val searchWordsShown: List<String> get() = words

    /** Go to a result in the room; the results make way. */
    fun pick(m: Message) {
        resultsShown = false
        controller.goTo(m.id)
    }

    // ---- reading (§18.3)

    /**
     * What the list shows is read: up to [shown], the newest saved message on screen whole, or everything at the bottom
     * of the live edge. Scrolling down through what is unread reads it as it comes into view. Not before [placed] (the
     * list has gone where the room opens, e.g. the first unread message: until then it shows its newest rows).
     */
    fun onScrolled(atBottom: Boolean, shown: Message?, placed: Boolean) {
        controller.atBottom = atBottom
        val s = controller.state.value
        if (atBottom) controller.dismissPill()
        if (!placed || s.unsure || s.phase != chirkle.android.data.repo.Phase.Ready || services.store.get().away) return
        val caughtUp = atBottom && !s.hasNewer
        val m = if (caughtUp) s.items.lastOrNull { it.status == null } else shown
        m?.let { reader?.seen(it.created, caughtUp) }
    }

    override fun onCleared() {
        services.opened.note(roomId)
        val s = controller.state.value
        reader?.close(caughtUp = controller.atBottom && !s.hasNewer)
        controller.close()
        services.closeRoom(roomId)
        if (editing == null) services.drafts.set(me, roomId, text.text, replyTo?.id.orEmpty())
    }

    private fun buildRows(s: RoomState): List<ListRow> {
        val out = ArrayList<ListRow>(s.items.size * 2 + 2)
        val items = s.items
        val byId = items.associateBy { it.id }
        for (i in items.indices.reversed()) {
            val m = quoting(items[i], byId)
            val prev = items.getOrNull(i - 1)
            out += ListRow.Msg(m, startsGroup(prev, m) || newDay(prev, m), m.id == s.targetId)
            if (m.id == s.unreadId) out += ListRow.NewLine
            if (newDay(prev, m)) out += ListRow.Day(Formats.day(m.created), "day-${m.id}")
        }
        if (!s.hasOlder && s.phase == chirkle.android.data.repo.Phase.Ready && !s.stale) out += ListRow.Beginning(beginning())
        return out
    }

    /**
     * A reply quotes the window's copy of its original when there is one, so the original's edits and deletes show live
     * (DESIGN.md §19.3, the web's quotedOf; QA BUG-181); else the copy it came with.
     */
    private fun quoting(m: Message, byId: Map<String, Message>): Message {
        if (m.replyTo.isEmpty()) return m
        val original = byId[m.replyTo] ?: return m
        val q = original.quote()
        if (m.expand?.replyTo == q) return m
        return m.copy(expand = (m.expand ?: chirkle.android.data.model.MessageExpand()).copy(replyTo = q))
    }

    private fun newDay(prev: Message?, m: Message): Boolean = prev == null || Formats.localDay(prev.created) != Formats.localDay(m.created)

    private fun beginning(): String {
        val r = services.store.get().rooms[roomId] ?: return "Beginning of the room"
        return if (r.isDm) "Beginning of your conversation with ${r.otherMember(me)?.name ?: "Unknown"}" else "Beginning of #${r.name}"
    }

    /** The newest page of messages with attachments, for the viewer (§17.7). */
    suspend fun mediaAround(): List<Message> = runCatching { services.api.page(Pages.withFiles(Pages.latest(roomId))) }.getOrDefault(emptyList())
}
