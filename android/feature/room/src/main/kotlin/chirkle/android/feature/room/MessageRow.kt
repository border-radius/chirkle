// One message in the list (DESIGN.md §7.6, §17.5, §19, §20.3, §21.3, §28): author and time at the start of a group,
// the text with its links, a reply's quote, a forward's origin, attachments, link previews, reactions, and how its send
// is going.
package chirkle.android.feature.room

import androidx.compose.ui.res.stringResource
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
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
import chirkle.android.data.lib.forwardHeader
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
    /** The quote of reply `from` was tapped: show the message it answers (`id`). */
    val onQuote: (id: String, from: String) -> Unit,
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
    /** The author's name was tapped: open the DM with them (DESIGN.md §16.5), or null where it can't be (see RoomScreen). */
    val onAuthor: ((User) -> Unit)? = null,
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
    val res = LocalContext.current.resources
    if (m.isService) return ServiceRow(m)
    val context = LocalContext.current
    val highlight by animateColorAsState(if (target) Chirkle.colors.highlight else Color.Transparent, tween(if (target) 150 else 1200), label = "target")
    val author = m.expand?.author ?: User(m.author, stringResource(R.string.room_unknown))
    val accent = MaterialTheme.colorScheme.primary
    // No tinted card for a message to you any more (the room view redesign, 2026-11-23): a mention of you is highlighted
    // in the text, a reply to you told by its quote, the pill with your name in the accent (§91).
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .background(if (selected) Chirkle.colors.tint else highlight)
                .combinedClickable(
                    onClick = { actions.onTap(m) },
                    onLongClick = { actions.onLongPress(m) },
                    onLongClickLabel = stringResource(R.string.room_message_actions),
                )
                .padding(start = 12.dp, end = 12.dp, top = if (first) 10.dp else 1.dp, bottom = 1.dp)
                .semantics { if (selecting) stateDescription = if (selected) res.getString(R.string.room_selected) else res.getString(R.string.room_not_selected) },
        ) {
            if (selecting) {
                Checkbox(selected, onCheckedChange = null, modifier = Modifier.padding(end = 4.dp))
            }
            Box(Modifier.padding(top = 2.dp).width(48.dp)) { if (first) Avatar(author, 36.dp) }
            Column(Modifier.weight(1f)) {
                if (first) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        // Another (known) author's name opens the DM with them (the web's button.author); not while selecting.
                        val open = actions.onAuthor?.takeIf { m.expand?.author != null && m.author != me && !author.noDms && !selecting }
                        Text(
                            author.name,
                            fontWeight = FontWeight.Bold,
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false).alignByBaseline()
                                .then(if (open == null) Modifier else Modifier.clickable(onClickLabel = stringResource(R.string.room_message_2, author.name)) { open(author) }),
                        )
                        Text(Formats.time(m.created), color = Chirkle.colors.muted, style = MaterialTheme.typography.labelSmall, modifier = Modifier.alignByBaseline())
                    }
                }
                if (m.forwardedFrom.isNotEmpty()) {
                    Text(stringResource(R.string.room_forwarded_from, m.expand?.forwardedFrom?.name ?: stringResource(R.string.room_unknown)), color = Chirkle.colors.muted, style = MaterialTheme.typography.labelMedium, fontStyle = FontStyle.Italic)
                }
                m.expand?.replyTo?.takeIf { m.replyTo.isNotEmpty() }?.let { q ->
                    // A one-line pill under the name (the web's .reply-quote, the reply redesign): the quoted author's
                    // face, name and text, an image icon before "Attachment" for files alone. Your own words: on the
                    // accent's tint, your name in the accent.
                    val who = q.expand?.author
                    val name = who?.name.orEmpty()
                    val mine = me != null && q.author == me
                    val filesOnly = !q.deleted && q.text.isBlank() && q.files.isNotEmpty()
                    Row(
                        Modifier
                            .padding(top = if (first) 4.dp else 8.dp, bottom = 4.dp)
                            .heightIn(min = 26.dp)
                            .clip(RoundedCornerShape(50))
                            .background(if (mine) Chirkle.colors.tint else MaterialTheme.colorScheme.surfaceContainerHigh)
                            .clickable(onClickLabel = stringResource(R.string.room_show_the_original_message)) { actions.onQuote(q.id, m.id) }
                            .padding(start = if (who != null) 3.dp else 12.dp, end = 12.dp, top = 3.dp, bottom = 3.dp)
                            .semantics(mergeDescendants = true) { contentDescription = res.getString(R.string.room_quoting, name.ifEmpty { res.getString(R.string.room_a_message) }, q.line()) },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        if (who != null) Avatar(who, 20.dp)
                        if (name.isNotEmpty()) {
                            Text(name, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = if (mine) accent else Chirkle.colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false).widthIn(max = 160.dp))
                        }
                        if (filesOnly) Icon(ChirkleIcons.Image, contentDescription = null, tint = Chirkle.colors.muted, modifier = Modifier.size(12.dp))
                        Text(
                            q.line(),
                            style = MaterialTheme.typography.bodySmall,
                            fontStyle = if (q.deleted) FontStyle.Italic else FontStyle.Normal,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            color = if (mine) MaterialTheme.colorScheme.onSurface else Chirkle.colors.muted,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                    }
                }
                when {
                    m.deleted -> Text(stringResource(R.string.room_message_deleted), color = Chirkle.colors.muted, fontStyle = FontStyle.Italic)
                    m.isEmptyForward() -> Text(stringResource(R.string.room_the_original_message_was_deleted), color = Chirkle.colors.muted, fontStyle = FontStyle.Italic)
                    else -> {
                        // The Telegram bridge's "↪ Forwarded from Bob" line shows small, like a forward's own header (§26.4).
                        val (header, body) = remember(m.text) { forwardHeader(m.text) }
                        if (header.isNotEmpty()) {
                            Text(header, color = Chirkle.colors.muted, style = MaterialTheme.typography.labelMedium, fontStyle = FontStyle.Italic)
                        }
                        if (body.isNotEmpty()) {
                            val muted = Chirkle.colors.muted
                            val edited = m.editedAt.isNotEmpty()
                            // "(edited)" follows the text on its line, as on the web.
                            val mark = Chirkle.colors.tint
                            val ink = MaterialTheme.colorScheme.onSurface
                            // Your handle only where the server says the message mentions you: one given up and taken by
                            // you since is someone else's in older messages (QA BUG-265).
                            val mine = if (me != null && me in m.mentions) actions.myHandle else ""
                            val text = remember(body, accent, edited, muted, mine, mark, ink) {
                                val t = linked(body, accent, mine, mark, ink) { openLink(context, it) }
                                if (!edited) t else androidx.compose.ui.text.buildAnnotatedString {
                                    append(t)
                                    append(" ")
                                    withStyle(androidx.compose.ui.text.SpanStyle(color = muted, fontSize = 12.sp)) { append(res.getString(R.string.room_edited_2)) }
                                }
                            }
                            Text(text, style = MaterialTheme.typography.bodyLarge.copy(lineHeight = 21.sp), modifier = if (edited) Modifier.semantics { stateDescription = res.getString(R.string.room_edited, Formats.full(m.editedAt)) } else Modifier)
                        } else if (m.editedAt.isNotEmpty()) {
                            Text(stringResource(R.string.room_edited_2), color = Chirkle.colors.muted, style = MaterialTheme.typography.labelSmall, modifier = Modifier.semantics { contentDescription = res.getString(R.string.room_edited, Formats.full(m.editedAt)) })
                        }
                        Attachments(m, actions)
                        for (p in m.previews) LinkPreviewRow(p.url, p.title, p.icon)
                    }
                }
                val reactions = actions.reactions(m)
                if (reactions.isNotEmpty() && !m.deleted) {
                    // As on the web: an emoji and its count with no chip around it, yours in the accent; pulled left by a
                    // reaction's padding so the first emoji lines up with the text.
                    FlowRow(Modifier.padding(top = 4.dp).offset(x = (-6).dp), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        for (r in reactions) {
                            val mine = me != null && me in r.users
                            val who = reactors(r.users, me.orEmpty(), actions.name)
                            Row(
                                Modifier
                                    .heightIn(min = 32.dp)
                                    .clip(RoundedCornerShape(16.dp))
                                    .clickable(enabled = me != null) { actions.onReact(m, r.emoji) }
                                    .padding(horizontal = 6.dp)
                                    .semantics(mergeDescendants = true) {
                                        contentDescription = res.getString(R.string.room_reacted_with, who, r.emoji)
                                        stateDescription = if (mine) res.getString(R.string.room_yours) else ""
                                    },
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(r.emoji, fontSize = 17.sp)
                                Spacer(Modifier.width(4.dp))
                                Text(
                                    r.users.size.toString(),
                                    fontSize = 14.sp,
                                    fontWeight = if (mine) FontWeight.Bold else FontWeight.Medium,
                                    color = if (mine) accent else Chirkle.colors.muted,
                                )
                            }
                        }
                        // As on the web: then the smiley-plus that adds one.
                        actions.onAddReaction?.let { add ->
                            Box(
                                Modifier
                                    .padding(start = 2.dp)
                                    .size(32.dp)
                                    .clip(RoundedCornerShape(16.dp))
                                    .clickable { add(m) }
                                    .semantics { contentDescription = res.getString(R.string.room_add_reaction) },
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(ChirkleIcons.AddReaction, contentDescription = null, tint = Chirkle.colors.dim, modifier = Modifier.size(18.dp))
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
    val res = LocalContext.current.resources
    when (m.status) {
        SendStatus.Pending -> {
            val p = actions.progress(m.id)
            if (m.localFiles.isNotEmpty() && p != null) {
                LinearProgressIndicator(progress = { p }, modifier = Modifier.padding(top = 4.dp).widthIn(max = 240.dp).fillMaxWidth().semantics { contentDescription = res.getString(R.string.room_uploading) })
            } else {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
                    Icon(ChirkleIcons.Pending, contentDescription = stringResource(R.string.room_sending), tint = Chirkle.colors.muted, modifier = Modifier.size(14.dp))
                }
            }
        }
        SendStatus.Failed -> {
            val replyGone = m.replyTo.isEmpty() && m.expand?.replyTo?.deleted == true
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(ChirkleIcons.Error, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text(
                    if (replyGone) stringResource(R.string.room_not_sent_the_message_you) else stringResource(R.string.room_not_sent),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f, fill = false),
                )
                TextButton(onClick = { actions.onRetry(m) }) { Text(if (replyGone) stringResource(R.string.room_send_without_quote) else stringResource(R.string.room_retry)) }
                TextButton(onClick = { actions.onDiscard(m) }) { Text(stringResource(R.string.room_discard)) }
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
    // Only http(s) links (as on the web).
    if (title.isEmpty() || !url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) return
    val context = LocalContext.current
    val site = chirkle.android.data.lib.siteOf(url)
    // A ghost line (the room view redesign, §28): no box, the favicon (or the site's first letter on a tile), the site
    // without "www.", a dot, the title; the title gives way first.
    Row(
        Modifier
            .padding(top = 2.dp)
            .heightIn(min = 32.dp)
            .clip(RoundedCornerShape(6.dp))
            .clickable { openLink(context, url) }
            .padding(vertical = 4.dp)
            .widthIn(max = 420.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon.startsWith("data:image/")) {
            AsyncImage(icon, contentDescription = null, modifier = Modifier.size(14.dp))
        } else if (site.isNotEmpty()) {
            Box(Modifier.size(14.dp).clip(RoundedCornerShape(3.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh), contentAlignment = Alignment.Center) {
                Text(site.take(1).uppercase(), fontSize = 9.sp, lineHeight = 9.sp, fontWeight = FontWeight.Bold, color = Chirkle.colors.muted)
            }
        }
        Spacer(Modifier.width(6.dp))
        if (site.isNotEmpty()) {
            Text(site, style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted, maxLines = 1, softWrap = false)
            Box(Modifier.padding(horizontal = 6.dp).size(3.dp).clip(androidx.compose.foundation.shape.CircleShape).background(Chirkle.colors.dim))
        }
        Text(title, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
    }
}
