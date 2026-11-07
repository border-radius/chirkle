// Finding a room, DM or collection by name (DESIGN.md §32, "Jump to"): a port of matches and score in web/src/views/switcher.ts.
// On the phone it is the room list's search; Ctrl+K opens it from a hardware keyboard.
package chirkle.android.data.lib

import chirkle.android.data.model.Collections
import chirkle.android.data.model.MediaCollection
import chirkle.android.data.model.Room
import java.text.Normalizer

/**
 * A room or DM to go to, or a collection ([room] null). [note]: "Hidden" or "Archived" (found only when typed for, [away]),
 * a collection's "Collection" or whose it is, else "".
 */
data class JumpTarget(val room: Room?, val name: String, val note: String, val at: String, val collection: MediaCollection? = null) {
    val away: Boolean get() = room != null && note.isNotEmpty()
    val id: String get() = room?.id ?: collection!!.id
}

private const val MAX_TARGETS = 50
private val MARKS = Regex("\\p{M}+")

/** Case, accents and width folded: "élan" and "ＥＬＡＮ" are found by "elan". */
fun jumpFold(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFKD).replace(MARKS, "").lowercase()

private fun isWordChar(cp: Int) = Character.isLetter(cp) || Character.isDigit(cp)

/**
 * How well [name] matches the folded query [q], best first: 0 the whole name, 1 its start, 2 a word's start, 3 inside
 * a word, 4 its letters in order; -1 not at all.
 */
fun jumpScore(name: String, q: String): Int {
    val n = jumpFold(name)
    if (n == q) return 0
    var i = n.indexOf(q)
    while (i >= 0) {
        if (i == 0) return 1
        if (!isWordChar(n.codePointBefore(i))) return 2
        i = n.indexOf(q, i + 1)
    }
    if (n.contains(q)) return 3
    // By code point: an emoji is one letter (QA BUG-138).
    val letters = q.filterNot { it.isWhitespace() }.codePoints().toArray()
    var j = 0
    for (c in n.codePoints()) if (j < letters.size && c == letters[j]) j++
    return if (j == letters.size) 4 else -1
}

/**
 * When each room was last open in this process (entered or left), as PocketBase dates: rooms have no latest message
 * time (only DMs do), so this is what puts a room you just used first (QA BUG-134). One per account (ChirkleServices),
 * forgotten when its session changes (QA BUG-136, BUG-152) and when the app restarts.
 */
class RecentlyOpened {
    private val at = java.util.concurrent.ConcurrentHashMap<String, String>()

    fun note(roomId: String) {
        at[roomId] = java.time.Instant.now().toString().replace('T', ' ')
    }

    operator fun get(roomId: String): String = at[roomId].orEmpty()

    fun clear() = at.clear()
}

/**
 * Everything you can jump to, from the room list's sections and your collections and those you follow, as the web's
 * (QA BUG-245). [opened]: when a room or collection was last open, "" if not yet.
 */
fun jumpTargets(s: RoomSections, me: String?, collections: Collections? = null, opened: (String) -> String): List<JumpTarget> {
    fun later(at: String, id: String) = opened(id).let { if (it > at) it else at }
    fun t(r: Room, note: String) =
        JumpTarget(r, if (r.isDm) r.otherMember(me)?.name ?: "Unknown" else r.name, note, later(r.lastMessageAt.ifEmpty { r.created }, r.id))
    fun c(c: MediaCollection) = JumpTarget(null, c.name, c.owner?.name ?: "Collection", later(c.lastAdded, c.id), c)
    return s.rooms.map { t(it, "") } + s.dms.map { t(it, "") } + s.hidden.map { t(it, "Hidden") } + s.archived.map { t(it, "Archived") } +
        (collections?.mine.orEmpty() + collections?.subs.orEmpty()).map(::c)
}

/**
 * What to show for [query]: the best matches first, then those not hidden or archived, then the most recent. With
 * nothing typed, everything but hidden and archived rooms, most recent first. A leading "#" or "@" is ignored.
 */
fun jumpMatches(all: List<JumpTarget>, query: String): List<JumpTarget> {
    val q = jumpFold(query.trim().removePrefix("#").removePrefix("@").trim())
    val recent = compareByDescending<JumpTarget> { it.at }
    if (q.isEmpty()) return all.filter { !it.away }.sortedWith(recent).take(MAX_TARGETS)
    return all.map { it to jumpScore(it.name, q) }
        .filter { it.second >= 0 }
        .sortedWith(compareBy<Pair<JumpTarget, Int>> { it.second }.thenBy { it.first.away }.thenByDescending { it.first.at })
        .take(MAX_TARGETS)
        .map { it.first }
}
