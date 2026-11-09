// Links in message text (DESIGN.md §7.6.3), as web/src/lib/links.ts finds them. Pure, so what becomes a link is tested.
package chirkle.android.data.lib

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * A piece of message text: plain, a link with where it goes, or a mention (DESIGN.md §41: [Mention.handle] in lower case
 * without the "@", [Mention.text] as written; lib/Mentions.kt).
 */
sealed interface TextPart {
    data class Plain(val text: String) : TextPart
    data class Link(val text: String, val href: String) : TextPart
    data class Mention(val handle: String, val text: String) : TextPart
}

/**
 * JavaScript's `\s`, spelled out: `\s` and `\b` mean different things in java.util.regex (the JVM tests) and in ICU
 * (Android), and the web's rules are the ones to match.
 */
private const val JS_SPACE = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"

/** Candidates: `http(s)://…` or `www.…` not inside a word, up to a space or a character URLs don't contain unescaped. */
private val CANDIDATE = Regex("(?<![A-Za-z0-9_])(?:[hH][tT][tT][pP][sS]?://|[wW][wW][wW]\\.)[^$JS_SPACE<>\"]+")

/** Punctuation that ends a sentence rather than a URL, typographic quotes and CJK punctuation included. */
private val TRAILING = Regex("[.,:;!?'\"*_…。\\p{Pi}\\p{Pf}]")
private val OPENING = mapOf(')' to '(', ']' to '[')
private val WWW = Regex("^[wW][wW][wW]\\.")

/**
 * Split [text] into plain runs and links. Only http(s) URLs become links (`www.example.com` → https), so a
 * `javascript:` or `data:` URL never does. Trailing punctuation stays text, and so does a closing bracket the link
 * didn't open.
 */
fun linkify(text: String): List<TextPart> {
    val out = mutableListOf<TextPart>()
    var at = 0
    for (match in CANDIDATE.findAll(text)) {
        var url = match.value
        while (url.isNotEmpty()) {
            val last = url.last()
            val open = OPENING[last]
            if (!TRAILING.matches(last.toString()) && !(open != null && url.count { it == open } < url.count { it == last })) break
            url = url.dropLast(1)
        }
        val start = match.range.first
        val www = WWW.containsMatchIn(url)
        // Not the www. inside an email address or a longer host name (bob@www.example.com, my.www.example.com).
        if (www && start > 0 && text[start - 1] in "@.-") continue
        val href = (if (www) "https://$url" else url).toHttpUrlOrNull()?.toString() ?: continue
        if (start > at) out += TextPart.Plain(text.substring(at, start))
        out += TextPart.Link(url, href)
        at = start + url.length
    }
    if (at < text.length) out += TextPart.Plain(text.substring(at))
    return out
}
