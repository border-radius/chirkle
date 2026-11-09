// "@handle" in message text (DESIGN.md §41): web/src/lib/mentions.ts, run on the same vectors (shared/vectors/mentions.json).
// Keep in sync with pb_hooks/lib/handles.js MENTION.
package chirkle.android.data.lib

/** "@handle": after the start or anything but a letter, digit, "_", "@", "." or "/", and not followed by one of those. */
private val MENTION = Regex("""(^|[^A-Za-z0-9_@./])@([A-Za-z0-9_]{3,24})(?![A-Za-z0-9_@])""")

/** [text] as plain runs and mentions. */
fun splitMentions(text: String): List<TextPart> {
    val out = mutableListOf<TextPart>()
    var at = 0
    for (m in MENTION.findAll(text)) {
        val start = m.range.first + m.groupValues[1].length
        if (start > at) out += TextPart.Plain(text.substring(at, start))
        val h = m.groupValues[2]
        out += TextPart.Mention(h.lowercase(), "@$h")
        at = start + h.length + 1
    }
    if (at < text.length) out += TextPart.Plain(text.substring(at))
    return out
}

/** The handles [text] mentions, in lower case, each once, in order. */
fun mentionedHandles(text: String): List<String> = splitMentions(text).filterIsInstance<TextPart.Mention>().map { it.handle }.distinct()

/** "@an" being typed just before [caret]: where its "@" is, and what follows it so far (maybe nothing), in lower case. */
data class MentionToken(val start: Int, val query: String)

private val TYPING = Regex("""(?:^|[^A-Za-z0-9_@./])@([A-Za-z0-9_]{0,24})$""")

fun mentionToken(text: String, caret: Int): MentionToken? {
    val m = TYPING.find(text.substring(0, caret.coerceIn(0, text.length))) ?: return null
    val q = m.groupValues[1]
    return MentionToken(caret - q.length - 1, q.lowercase())
}
