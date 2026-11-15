// The message list as a sliding window over a room's history (DESIGN.md §7.5): web/src/lib/messages.ts.
// Pure: every operation returns a new window (or the same one when nothing changed).
package chirkle.android.data.lib

import chirkle.android.data.model.Message
import chirkle.android.data.model.Quoted
import chirkle.android.data.model.QuotedExpand

const val WINDOW_MAX = 300
private const val GROUP_GAP_MS = 5 * 60 * 1000L

data class MessageWindow(
    /** Sorted by (created, id); at most [WINDOW_MAX] after trimming. */
    val items: List<Message> = emptyList(),
    /** false ⇒ items[0] is the room's very first message. */
    val hasOlder: Boolean = false,
    /** false ⇒ the window is at the live edge. */
    val hasNewer: Boolean = false,
)

enum class PageKind { Latest, First, Older, Newer }

enum class Side { Top, Bottom }

val MessageOrder: Comparator<Message> = compareBy<Message>({ it.created }, { it.id })

/** Which of two copies of the same message to keep. */
private fun newest(current: Message, incoming: Message): Message = when {
    current.status != null && incoming.status == null -> incoming // the server's copy replaces the optimistic one
    current.status == null && incoming.status != null -> current // never back to an optimistic copy
    incoming.updated >= current.updated -> incoming
    else -> current
}

/** Merge messages into the window: one copy per id (the newest), in (created, id) order. */
fun MessageWindow.merge(incoming: Collection<Message>): MessageWindow {
    if (incoming.isEmpty()) return this
    val byId = LinkedHashMap<String, Message>(items.size + incoming.size)
    for (m in items) byId[m.id] = m
    for (m in incoming) byId[m.id] = byId[m.id]?.let { newest(it, m) } ?: m
    return copy(items = byId.values.sortedWith(MessageOrder))
}

fun MessageWindow.remove(id: String): MessageWindow =
    if (items.none { it.id == id }) this else copy(items = items.filter { it.id != id })

data class Trimmed(val win: MessageWindow, val dropped: List<String>)

/** Drop messages beyond [max] from one end: Bottom drops the newest, Top the oldest. */
fun MessageWindow.trim(side: Side, max: Int = WINDOW_MAX): Trimmed {
    val extra = items.size - max
    if (extra <= 0) return Trimmed(this, emptyList())
    return when (side) {
        Side.Bottom -> Trimmed(copy(items = items.take(max), hasNewer = true), items.drop(max).map { it.id })
        Side.Top -> Trimmed(copy(items = items.drop(extra), hasOlder = true), items.take(extra).map { it.id })
    }
}

/**
 * Apply a fetched page (in any order). Latest/First reset the window; Older/Newer extend it and trim the opposite
 * end. A page shorter than [PAGE_SIZE] means that end of the history has been reached.
 */
fun MessageWindow.applyPage(page: List<Message>, kind: PageKind): Trimmed {
    val full = page.size >= PAGE_SIZE
    return when (kind) {
        PageKind.Latest -> Trimmed(MessageWindow(hasOlder = full).merge(page), emptyList())
        PageKind.First -> Trimmed(MessageWindow(hasNewer = full).merge(page), emptyList())
        PageKind.Older -> merge(page).copy(hasOlder = full).trim(Side.Bottom)
        PageKind.Newer -> merge(page).copy(hasNewer = full).trim(Side.Top)
    }
}

/** Does [cur] start a new author group after [prev]? (another author, or a gap over 5 minutes) */
fun startsGroup(prev: Message?, cur: Message): Boolean {
    if (prev == null || prev.author != cur.author) return true
    return parsePb(cur.created) - parsePb(prev.created) > GROUP_GAP_MS
}

/** The newest message the server has (not pending or failed): what read state and gap fill go by. */
fun MessageWindow.lastSaved(): Message? = items.lastOrNull { it.status == null }

/** My newest message that can be edited. */
fun MessageWindow.lastOwnEditable(me: String): Message? =
    items.lastOrNull { it.author == me && !it.deleted && it.status == null && it.forwardedFrom.isEmpty() }

/** A forward whose original was deleted: nothing left to show, or to forward again (§21.3). */
fun Message.isEmptyForward(): Boolean = forwardedFrom.isNotEmpty() && text.isEmpty() && files.isEmpty()

/** What a reply keeps of the message it answers (§19). */
fun Message.quote(): Quoted = Quoted(id, author, text, deleted, files, expand?.author?.let { QuotedExpand(it) })

/** One line of a quoted message: its text on one line, or what it holds when it has none (§19). */
fun quoteText(text: String, deleted: Boolean, files: Int): String {
    if (deleted) return Strings.MESSAGE_DELETED
    val one = text.replace(Regex("\\s+"), " ").trim()
    if (one.isNotEmpty()) return one
    return when (files) {
        0 -> Strings.MESSAGE_DELETED // a forward whose original was deleted (§21.3)
        1 -> Strings.ATTACHMENT
        else -> Strings.attachments(files)
    }
}

fun Quoted.line(): String = quoteText(text, deleted, files.size)
