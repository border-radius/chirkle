// Message text with its links (DESIGN.md §7.6.3): what linkify() finds, opened in Custom Tabs, never in the app.
package chirkle.android.ui

import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.graphics.Color
import chirkle.android.data.lib.TextPart
import chirkle.android.data.lib.linkify
import chirkle.android.data.lib.splitMentions
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle

/**
 * [text] with its http(s) links as links in [color]; [open] is called with a link's address. Its "@handle"s (DESIGN.md
 * §41) in [color] and bold, yours ([mine], your handle) in [mineColor] on [mineBackground], as the web's .mention and
 * .mention.me (the accent on the tint was under 4.5:1: QA BUG-262).
 */
fun linked(
    text: String,
    color: Color,
    mine: String = "",
    mineBackground: Color = Color.Unspecified,
    mineColor: Color = color,
    open: (String) -> Unit,
): AnnotatedString =
    buildAnnotatedString {
        val style = TextLinkStyles(SpanStyle(color = color, textDecoration = TextDecoration.Underline))
        for (part in linkify(text)) {
            when (part) {
                is TextPart.Plain -> for (piece in splitMentions(part.text)) {
                    when (piece) {
                        is TextPart.Mention -> {
                            val me = mine.isNotEmpty() && piece.handle == mine
                            withStyle(SpanStyle(color = if (me) mineColor else color, fontWeight = FontWeight.SemiBold, background = if (me) mineBackground else Color.Unspecified)) {
                                append(piece.text)
                            }
                        }
                        is TextPart.Plain -> append(piece.text)
                        is TextPart.Link -> append(piece.text)
                    }
                }
                is TextPart.Link -> withLink(LinkAnnotation.Clickable(part.href, style) { open(part.href) }) { append(part.text) }
                is TextPart.Mention -> append(part.text)
            }
        }
    }

/** Open a web address in a Custom Tab (http and https only: that is all linkify() makes links of). */
fun openLink(context: Context, href: String) {
    val uri = Uri.parse(href)
    if (uri.scheme != "https" && uri.scheme != "http") return
    runCatching { CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri) }
}
