// Text rules shared with the server: lengths as PocketBase counts them, and the folding behind unique names (§22.1)
// and message search (§29.1). Ports of web/src/lib/limits.ts and foldKey / pb_hooks/lib/text.js.
package chirkle.android.data.lib

import java.text.Normalizer

/** Field limits the app enforces before the server does; they mirror pb_migrations (web/src/lib/limits.ts). */
object Limits {
    const val MESSAGE_TEXT = 2000
    const val USER_NAME = 32
    const val ROOM_NAME = 48
    const val PASSWORD_MIN = 8
    /** In UTF-8 bytes: bcrypt's 72, PocketBase's 71, which refuses a longer one on signup without saying why (QA BUG-267). */
    const val PASSWORD_MAX_BYTES = 71
    const val AVATAR_BYTES = 2L * 1024 * 1024
    val AVATAR_TYPES = setOf("image/jpeg", "image/png", "image/webp", "image/gif")
    const val ATTACHMENTS = 10
    const val ATTACHMENT_BYTES = 20L * 1024 * 1024
    const val ROOM_MEMBERS = 100
    /** Most messages selected, and so deleted or forwarded, at once (§21). */
    const val MAX_SELECTED = 50
}

/** Length as PocketBase counts it: Unicode code points, not UTF-16 units (an emoji is 1, not 2). */
fun textLength(s: String): Int = s.codePointCount(0, s.length)

/** Invisible format characters: zero-width spaces and joiners, bidi marks, word joiners, BOM, soft hyphen. */
private val INVISIBLE = Regex("[\\u00AD\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]")

/** Text made only of spaces and invisible characters: nothing to send. */
fun isBlank(s: String): Boolean = s.replace(INVISIBLE, "").isBlank()

/** The uniqueness key of names (users, rooms): NFKC and full case folding, without invisible characters. */
fun nameKey(s: String): String = Normalizer.normalize(s.replace(INVISIBLE, ""), Normalizer.Form.NFKC).uppercase().lowercase()

/** What message search matches (messages.text_key): folded as names are, and "İ" as "i" (QA BUG-113). */
fun foldKey(s: String): String = nameKey(s).replace("i̇", "i")

private val CONTROL = Regex("[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]")
private val SPACES = Regex("\\s+")
private val LEADING_HASH = Regex("^[#\\s]+")

/**
 * A name as the server compares names on create (web/src/lib/rooms.ts `nameKey`; tidy() and nameKey() in
 * pb_hooks/lib/text.js): invisible characters dropped, control characters as spaces, spaces tidied, then [nameKey].
 * [room]: leading "#"s go too, as the server strips them from room names.
 */
fun listedNameKey(name: String, room: Boolean = false): String {
    var s = name.replace(INVISIBLE, "").replace(CONTROL, " ").replace(SPACES, " ").trim()
    if (room) s = s.replace(LEADING_HASH, "")
    return nameKey(s)
}

/** A room name without its leading "#"s, as the room list shows it after its "#" (the taken line's "#design"). */
fun bareRoomName(name: String): String = name.replace(LEADING_HASH, "")

/**
 * Where [query] first matches [text], ignoring case, for the bold letters in people's search results (web/src/ui/
 * user-search.ts `marked`); null when it doesn't, or when lowercasing changes the text's length (no safe offsets).
 */
fun matchRange(text: String, query: String): IntRange? {
    if (query.isEmpty()) return null
    val lower = text.lowercase()
    if (lower.length != text.length) return null
    val i = lower.indexOf(query.lowercase())
    return if (i < 0) null else i until i + query.length
}

/** A link's site as its preview line shows it (web/src/views/room/messages.ts `siteOf`): its host without "www.". */
fun siteOf(url: String): String = runCatching { java.net.URI(url).host.orEmpty().lowercase().removePrefix("www.") }.getOrDefault("")
