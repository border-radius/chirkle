// One message in the list (DESIGN.md §7.6, §17.5, §19, §20.3, §21.3, §28): author and time at the start of a group,
// the text with its links, a reply's quote, a forward's origin, attachments, link previews, reactions, and how its send
// is going.
package chirkle.android.feature.room

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.withStyle
import chirkle.android.data.lib.isEmptyForward
import chirkle.android.data.lib.line
import chirkle.android.data.lib.reactors
import chirkle.android.data.model.Message
import chirkle.android.data.model.Reaction
import chirkle.android.data.model.SendStatus
import chirkle.android.data.model.User
import chirkle.android.ui.Avatar
import chirkle.android.ui.Chirkle
import chirkle.android.ui.ChirkleIcons
import chirkle.android.ui.Formats
import chirkle.android.ui.linked
import chirkle.android.ui.openLink
import coil3.compose.AsyncImage

/** What a row can do; the screen decides what each one means. */
class RowActions(
    val onLongPress: (Message) -> Unit,
    val onTap: (Message) -> Unit,
    val onQuote: (String) -> Unit,
    val onReact: (Message, String) -> Unit,
    val onRetry: (Message) -> Unit,
    val onDiscard: (Message) -> Unit,
    val onOpenMedia: (Message, String) -> Unit,
    val onFile: (Message, String) -> Unit,
    val reactions: (Message) -> List<Reaction>,
    val name: (String) -> String?,
    val progress: (String) -> Float?,
    /** The emoji picker for a reaction, or null where you can't react (a guest, an archived room). */
    val onAddReaction: ((Message) -> Unit)? = null,
    /** Save a file to your collections (§31.3), or null for a guest. */
    val onSave: ((Message, String) -> Unit)? = null,
    /** What the badge of a file from this collection says; null until known, or for one that is gone. */
    val badge: (String) -> chirkle.android.data.model.Badge? = { null },
    /** Open a collection's page (a badge was tapped). */
    val onCollection: (String) -> Unit = {},
    /** Your handle (DESIGN.md §41): an "@" of it is marked more. */
    val myHandle: String = "",
)

@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
fun MessageRow(
    m: Message,
    first: Boolean,
    target: Boolean,
    me: String?,
    selecting: Boolean,
    selected: Boolean,
    actions: RowActions,
) {
    if (m.isService) return ServiceRow(m)
    val context = LocalContext.current
    val highlight by animateColorAsState(if (target) Chirkle.colors.highlight else Color.Transparent, tween(if (target) 150 else 1200), label = "target")
    val author = m.expand?.author ?: User(m.author, "Unknown")
    val accent = MaterialTheme.colorScheme.primary
    // A reply to one of my messages or a mention of me (DESIGN.md §41), by someone else: a tinted card (the web's .to-me).
    val toMe = me != null && m.author != me && ((m.replyTo.isNotEmpty() && m.expand?.replyTo?.author == me) || me in m.mentions)
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .then(if (toMe) Modifier.padding(start = 8.dp, end = 8.dp, top = 4.dp).clip(RoundedCornerShape(16.dp)).background(Chirkle.colors.own) else Modifier)
                .background(if (selected) Chirkle.colors.tint else highlight)
                .combinedClickable(
                    onClick = { actions.onTap(m) },
                    onLongClick = { actions.onLongPress(m) },
                    onLongClickLabel = "Message actions",
                )
                .padding(start = if (toMe) 4.dp else 12.dp, end = if (toMe) 4.dp else 12.dp, top = if (first || toMe) 10.dp else 1.dp, bottom = if (toMe) 10.dp else 1.dp)
                .semantics { if (selecting) stateDescription = if (selected) "Selected" else "Not selected" },
        ) {
            if (selecting) {
                Checkbox(selected, onCheckedChange = null, modifier = Modifier.padding(end = 4.dp))
            }
            Box(Modifier.padding(top = 2.dp).width(48.dp)) { if (first) Avatar(author, 36.dp) }
            Column(Modifier.weight(1f)) {
                if (first) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(author.name, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false).alignByBaseline())
                        Text(Formats.time(m.created), color = Chirkle.colors.muted, style = MaterialTheme.typography.labelSmall, modifier = Modifier.alignByBaseline())
                    }
                }
                if (m.forwardedFrom.isNotEmpty()) {
                    Text("Forwarded from ${m.expand?.forwardedFrom?.name ?: "Unknown"}", color = Chirkle.colors.muted, style = MaterialTheme.typography.labelMedium, fontStyle = FontStyle.Italic)
                }
                m.expand?.replyTo?.takeIf { m.replyTo.isNotEmpty() }?.let { q ->
                    val name = q.expand?.author?.name.orEmpty()
                    Row(
                        Modifier
                            .padding(vertical = 2.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(MaterialTheme.colorScheme.surfaceContainer)
                            .clickable(onClickLabel = "Show the original message") { actions.onQuote(q.id) }
                            .padding(horizontal = 8.dp, vertical = 4.dp)
                            .semantics(mergeDescendants = true) { contentDescription = "Quoting ${name.ifEmpty { "a message" }}: ${q.line()}" },
                    ) {
                        Box(Modifier.width(3.dp).height(32.dp).background(accent, RoundedCornerShape(2.dp)))
                        Spacer(Modifier.width(8.dp))
                        Column {
                            if (name.isNotEmpty()) Text(name, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = accent)
                            Text(q.line(), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Chirkle.colors.muted)
                        }
                    }
                }
                when {
                    m.deleted -> Text("Message deleted", color = Chirkle.colors.muted, fontStyle = FontStyle.Italic)
                    m.isEmptyForward() -> Text("The original message was deleted", color = Chirkle.colors.muted, fontStyle = FontStyle.Italic)
                    else -> {
                        if (m.text.isNotEmpty()) {
                            val muted = Chirkle.colors.muted
                            val edited = m.editedAt.isNotEmpty()
                            // "(edited)" follows the text on its line, as on the web.
                            val mark = Chirkle.colors.tint
                            val text = remember(m.text, accent, edited, muted, actions.myHandle, mark) {
                                val t = linked(m.text, accent, actions.myHandle, mark) { openLink(context, it) }
                                if (!edited) t else androidx.compose.ui.text.buildAnnotatedString {
                                    append(t)
                                    append(" ")
                                    withStyle(androidx.compose.ui.text.SpanStyle(color = muted, fontSize = 12.sp)) { append("(edited)") }
                                }
                            }
                            Text(text, style = MaterialTheme.typography.bodyLarge.copy(lineHeight = 21.sp), modifier = if (edited) Modifier.semantics { stateDescription = "Edited ${Formats.full(m.editedAt)}" } else Modifier)
                        } else if (m.editedAt.isNotEmpty()) {
                            Text("(edited)", color = Chirkle.colors.muted, style = MaterialTheme.typography.labelSmall, modifier = Modifier.semantics { contentDescription = "Edited ${Formats.full(m.editedAt)}" })
                        }
                        Attachments(m, actions)
                        for (p in m.previews) LinkPreviewRow(p.url, p.title, p.icon)
                    }
                }
                val reactions = actions.reactions(m)
                if (reactions.isNotEmpty() && !m.deleted) {
                    FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (r in reactions) {
                            val mine = me != null && me in r.users
                            val who = reactors(r.users, me.orEmpty(), actions.name)
                            Row(
                                Modifier
                                    .heightIn(min = 32.dp)
                                    .clip(RoundedCornerShape(16.dp))
                                    .background(if (mine) Chirkle.colors.tint else MaterialTheme.colorScheme.surfaceContainer)
                                    .border(1.dp, if (mine) accent else Chirkle.colors.border, RoundedCornerShape(16.dp))
                                    .clickable(enabled = me != null) { actions.onReact(m, r.emoji) }
                                    .padding(horizontal = 10.dp, vertical = 4.dp)
                                    .semantics(mergeDescendants = true) {
                                        contentDescription = "$who reacted with ${r.emoji}"
                                        stateDescription = if (mine) "Yours" else ""
                                    },
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(r.emoji)
                                Spacer(Modifier.width(4.dp))
                                Text(r.users.size.toString(), style = MaterialTheme.typography.labelMedium, color = if (mine) accent else MaterialTheme.colorScheme.onSurface)
                            }
                        }
                        // As on the web: one more chip, to add a reaction.
                        actions.onAddReaction?.let { add ->
                            Box(
                                Modifier
                                    .height(32.dp)
                                    .clip(RoundedCornerShape(16.dp))
                                    .border(1.dp, Chirkle.colors.border, RoundedCornerShape(16.dp))
                                    .clickable { add(m) }
                                    .padding(horizontal = 10.dp)
                                    .semantics { contentDescription = "Add reaction" },
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(ChirkleIcons.AddReaction, contentDescription = null, tint = Chirkle.colors.muted, modifier = Modifier.size(18.dp))
                            }
                        }
                    }
                }
                SendState(m, actions)
            }
        }
    }
}

@Composable
private fun SendState(m: Message, actions: RowActions) {
    when (m.status) {
        SendStatus.Pending -> {
            val p = actions.progress(m.id)
            if (m.localFiles.isNotEmpty() && p != null) {
                LinearProgressIndicator(progress = { p }, modifier = Modifier.padding(top = 4.dp).widthIn(max = 240.dp).fillMaxWidth().semantics { contentDescription = "Uploading" })
            } else {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
                    Icon(ChirkleIcons.Pending, contentDescription = "Sending", tint = Chirkle.colors.muted, modifier = Modifier.size(14.dp))
                }
            }
        }
        SendStatus.Failed -> {
            val replyGone = m.replyTo.isEmpty() && m.expand?.replyTo?.deleted == true
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(ChirkleIcons.Error, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text(
                    if (replyGone) "Not sent: the message you replied to was deleted." else "Not sent.",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f, fill = false),
                )
                TextButton(onClick = { actions.onRetry(m) }) { Text(if (replyGone) "Send without quote" else "Retry") }
                TextButton(onClick = { actions.onDiscard(m) }) { Text("Discard") }
            }
        }
        null -> {}
    }
}

@Composable
private fun ServiceRow(m: Message) {
    Text(
        m.text,
        color = Chirkle.colors.muted,
        style = MaterialTheme.typography.bodySmall,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp),
    )
}

@Composable
private fun LinkPreviewRow(url: String, title: String, icon: String) {
    if (title.isEmpty()) return
    val context = LocalContext.current
    Row(
        Modifier
            .padding(top = 4.dp)
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, Chirkle.colors.border, RoundedCornerShape(8.dp))
            .clickable { openLink(context, url) }
            .padding(horizontal = 8.dp, vertical = 6.dp)
            .widthIn(max = 360.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon.startsWith("data:image/")) {
            AsyncImage(icon, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(title, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}
