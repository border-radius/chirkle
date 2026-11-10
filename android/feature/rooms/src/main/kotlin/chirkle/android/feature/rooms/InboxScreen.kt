// "Mentions & replies" (DESIGN.md §41; web/src/views/inbox.ts): the messages that mention you, the replies to yours and
// the reactions to them, newest first, each opening its message in its room. What you hadn't seen is tinted, and opening
// the screen sees it. Something new while it is open comes in at the top.
package chirkle.android.feature.rooms

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import chirkle.android.data.lib.title
import chirkle.android.data.model.InboxItem
import chirkle.android.data.model.InboxMessage
import chirkle.android.ui.Avatar
import chirkle.android.ui.Chirkle
import chirkle.android.ui.ChirkleIcons
import chirkle.android.ui.Formats
import chirkle.android.ui.LocalServices
import kotlinx.coroutines.launch

/** What a row says happened, after who did it ("mentioned you in #room"). */
internal fun inboxWhat(item: InboxItem, room: String): String {
    val where = if (room.isEmpty()) "" else " in $room"
    return when (item.kind) {
        "reaction" -> " reacted ${item.emoji} to your message$where"
        "reply" -> " replied to you$where"
        else -> " mentioned you$where"
    }
}

/** A message's words on one line, or what it has instead. */
internal fun inboxWords(m: InboxMessage): String =
    m.text.ifEmpty { if (m.files == 1) "Attachment" else if (m.files > 1) "${m.files} attachments" else "Message deleted" }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(onOpen: (room: String, message: String) -> Unit, onBack: () -> Unit) {
    val services = LocalServices.current
    val app by services.store.flow.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var items by remember { mutableStateOf<List<InboxItem>>(emptyList()) }
    var cursor by remember { mutableStateOf("") }
    /** Seen before this visit: newer ones are tinted. Null until the first page is in. */
    var seenAt by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }

    /** You have seen everything listed: the server and the room list's count hear of it. */
    fun seeAll() {
        val newest = items.firstOrNull()?.created ?: return
        if (newest > (seenAt ?: "") || services.store.get().inbox > 0) {
            services.store.update { it.copy(inbox = 0) }
            scope.launch { runCatching { services.api.inboxSeen(newest) } }
        }
    }

    fun load(first: Boolean) {
        if (loading) return
        loading = true
        failed = false
        scope.launch {
            runCatching { services.api.inbox(if (first) "" else cursor) }
                .onSuccess { page ->
                    if (seenAt == null) seenAt = page.seenAt
                    items = if (first) page.items else items + page.items.filter { n -> items.none { it.id == n.id } }
                    // From the top again: keep how far "Show older" had got.
                    if (!first || cursor.isEmpty() || items.isEmpty()) cursor = if (page.more) page.items.lastOrNull()?.cursor.orEmpty() else ""
                    seeAll()
                }
                .onFailure { failed = true }
            loading = false
        }
    }
    LaunchedEffect(Unit) { load(true) }
    // A row taken away while you look (its message deleted, the mention edited out, the reaction taken back) goes,
    // rather than opening a message that isn't there (QA BUG-254).
    LaunchedEffect(Unit) {
        val stop = runCatching {
            services.api.subscribeInbox { ev ->
                if (ev.action == "delete") scope.launch(services.main) { items = items.filter { it.id != ev.id } }
            }
        }.getOrNull() ?: return@LaunchedEffect
        try {
            kotlinx.coroutines.awaitCancellation()
        } finally {
            services.appScope.launch { runCatching { stop() } }
        }
    }
    // Something new while you look (the count went up): the top again.
    LaunchedEffect(Unit) {
        var prev = services.store.get().inbox
        snapshotFlow { app.inbox }.collect { now ->
            if (now > prev) load(true)
            prev = now
        }
    }

    Scaffold(topBar = {
        TopAppBar(
            navigationIcon = { IconButton(onClick = onBack) { Icon(ChirkleIcons.Back, contentDescription = "Back to rooms") } },
            title = { Text("Mentions & replies") },
        )
    }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(items, key = { it.id }) { item ->
                val new = seenAt != null && item.created > seenAt!!
                val room = app.rooms[item.room]?.title(app.user?.id).orEmpty()
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(if (new) Chirkle.colors.tint else Color.Transparent)
                        .clickable(onClickLabel = "Open") { onOpen(item.room, item.message.id) }
                        .padding(12.dp)
                        .semantics(mergeDescendants = true) {},
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Avatar(item.actor, 36.dp)
                    Column(Modifier.weight(1f)) {
                        val muted = Chirkle.colors.muted
                        Text(
                            buildAnnotatedString {
                                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(item.actor.name) }
                                withStyle(SpanStyle(color = muted)) {
                                    append(inboxWhat(item, room))
                                    append("  ")
                                }
                                withStyle(SpanStyle(color = Chirkle.colors.dim, fontSize = 12.sp)) { append(Formats.time(item.created)) }
                            },
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        item.quote?.let {
                            Row(Modifier.padding(top = 4.dp)) {
                                Box(Modifier.size(width = 3.dp, height = 18.dp).background(Chirkle.colors.border, RoundedCornerShape(2.dp)))
                                Text(inboxWords(it), color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 8.dp))
                            }
                        }
                        Text(inboxWords(item.message), maxLines = 3, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 2.dp))
                    }
                }
            }
            item(key = "status") {
                Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    when {
                        loading -> CircularProgressIndicator(Modifier.size(28.dp))
                        failed -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("Couldn't load your mentions and replies.", color = Chirkle.colors.muted)
                            TextButton(onClick = { load(items.isEmpty()) }) { Text("Retry") }
                        }
                        cursor.isNotEmpty() -> TextButton(onClick = { load(false) }) { Text("Show older") }
                        items.isEmpty() && seenAt != null -> Text(
                            "Nothing here yet. When someone mentions you, replies to you or reacts to your message, it shows here.",
                            color = Chirkle.colors.muted,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
        }
    }
}
