// Keyset pagination over a room's messages, ordered by (created, id) (DESIGN.md §6, §7.5): web/src/lib/cursor.ts.
// Pure: which page to ask GET /api/chat/rooms/{room}/messages for (pb_hooks/lib/lists.js writes the filter).
package chirkle.android.data.lib

import chirkle.android.data.model.Cursor

const val PAGE_SIZE = 50

/**
 * A page of [room]: [kind] is latest, first, older, newer or changed; [args] its cursor (`created`, `id`; for changed,
 * `since`, `from`, `to`). [files]: only messages that may have attachments. [q]: only messages with every word of it
 * (search, §29; with latest and older), folded words separated by spaces; the server escapes them.
 */
data class PageQuery(val room: String, val kind: String, val args: Map<String, String> = emptyMap(), val files: Boolean = false, val q: String = "") {
    /** latest and older pages come back newest first; the others oldest first. */
    val descending: Boolean get() = kind == "latest" || kind == "older"

    /** The same page as a records API filter, for servers from before the route (docs/API.md). */
    fun legacy(): FilterQuery {
        val where = when (kind) {
            "older" -> " && (created < {:created} || (created = {:created} && id < {:id}))"
            "newer" -> " && (created > {:created} || (created = {:created} && id > {:id}))"
            "changed" -> " && updated > {:since} && created >= {:from} && created <= {:to}"
            else -> ""
        }
        val sort = if (kind == "changed") "updated,id" else if (descending) DESC else ASC
        // A file field before shared files, JSON since (DESIGN.md §37), where `:length` means nothing: both hold "[]" when empty.
        val withFiles = if (files) " && ((files:length > 0 && files != \"[]\") || forward_of != \"\")" else ""
        // `~` treats `%` as a wildcard, so it is escaped (QA BUG-34), and so is the escape character itself (QA BUG-112).
        val words = q.split(' ').filter { it.isNotEmpty() }
        val search = words.indices.joinToString("") { " && text_key ~ {:w$it}" }
        val params = words.withIndex().associate { "w${it.index}" to it.value.replace(Regex("[\\\\%]")) { m -> "\\" + m.value } }
        return FilterQuery("room = {:room}$search$where$withFiles", mapOf("room" to room) + params + args, sort)
    }
}

/** A records API query: the filter, its values (bound by PbClient, never concatenated) and the order. */
data class FilterQuery(val filter: String, val params: Map<String, String>, val sort: String)

private const val DESC = "-created,-id"
private const val ASC = "created,id"

object Pages {
    /** The newest page of a room (newest first). */
    fun latest(room: String) = PageQuery(room, "latest")

    /** The oldest page of a room (oldest first). */
    fun first(room: String) = PageQuery(room, "first")

    /** The page just before [c], the oldest loaded message (newest first). */
    fun older(room: String, c: Cursor) = PageQuery(room, "older", mapOf("created" to c.created, "id" to c.id))

    /** The page just after [c], the newest loaded message (oldest first). */
    fun newer(room: String, c: Cursor) = PageQuery(room, "newer", mapOf("created" to c.created, "id" to c.id))

    /** Messages from [from] to [to] (inclusive, by created) changed after [since]: edits and deletes missed offline. */
    fun changedIn(room: String, since: String, from: Cursor, to: Cursor) =
        PageQuery(room, "changed", mapOf("since" to since, "from" to from.created, "to" to to.created))

    /** Only the messages of [q] that may have attachments: their own, or a forward's original's (§17.7). */
    fun withFiles(q: PageQuery) = q.copy(files = true)
}
