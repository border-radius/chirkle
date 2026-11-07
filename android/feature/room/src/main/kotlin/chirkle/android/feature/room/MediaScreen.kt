// A room's images and videos as a grid (DESIGN.md §30; web/src/views/room/media.ts): newest first under month
// headings, 60 a page, older ones fetched near the end. A tile opens the viewer there; a video's tile is its poster.
package chirkle.android.feature.room

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import chirkle.android.data.lib.parsePb
import chirkle.android.data.lib.title
import chirkle.android.data.model.MediaItem
import chirkle.android.ui.Chirkle
import chirkle.android.ui.ChirkleIcons
import chirkle.android.ui.Formats
import chirkle.android.ui.Images
import chirkle.android.ui.LocalServices
import coil3.compose.AsyncImage
import chirkle.android.data.api.Action
import chirkle.android.data.api.Change
import chirkle.android.data.model.Message
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** A grid's month heading ("October 2026"), in the locale of the moment (media grid, collection page). */
internal fun month(sent: String): String {
    val ms = parsePb(sent)
    return if (ms == Long.MIN_VALUE) "" else DateTimeFormatter.ofPattern("LLLL yyyy", Locale.getDefault()).format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MediaScreen(roomId: String, onOpen: (msgId: String, file: String) -> Unit, onBack: () -> Unit) {
    val services = LocalServices.current
    val context = LocalContext.current
    val app by services.store.flow.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var items by remember { mutableStateOf<List<MediaItem>>(emptyList()) }
    var more by remember { mutableStateOf(true) }
    var loading by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    val grid = rememberLazyGridState()

    fun load() {
        if (loading || !more) return
        loading = true
        failed = false
        scope.launch {
            runCatching { services.api.media(roomId, items.lastOrNull()) }
                .onSuccess { page ->
                    items = items + page.items
                    more = page.more
                }
                .onFailure { failed = true }
            loading = false
        }
    }
    LaunchedEffect(roomId) { load() }
    // A message deleted meanwhile takes its tiles with it: opened, they showed a broken image (QA BUG-244, as the viewer's BUG-155).
    LaunchedEffect(roomId) {
        val changes = Channel<Change<Message>>(Channel.UNLIMITED)
        val off = runCatching { services.api.subscribeMessages(roomId) { changes.trySend(it) } }.getOrNull() ?: return@LaunchedEffect
        try {
            for (c in changes) {
                val m = c.record
                val has = if (c.action == Action.Delete || m.deleted) emptySet() else m.files.toSet()
                if (items.any { it.message == m.id && it.file !in has }) items = items.filter { it.message != m.id || it.file in has }
            }
        } finally {
            withContext(NonCancellable) { runCatching { off() } }
        }
    }
    // Near the end: the next page (not after a failure, until Retry: QA BUG-116).
    LaunchedEffect(grid) {
        snapshotFlow { grid.layoutInfo.visibleItemsInfo.lastOrNull()?.index to grid.layoutInfo.totalItemsCount }
            .distinctUntilChanged()
            .collect { (last, total) -> if (last != null && last >= total - 12 && !failed) load() }
    }

    Scaffold(topBar = {
        TopAppBar(
            navigationIcon = { IconButton(onClick = onBack) { Icon(ChirkleIcons.Back, contentDescription = "Back to the room") } },
            title = {
                Column {
                    Text("Media")
                    app.rooms[roomId]?.let { Text(it.title(app.user?.id), style = MaterialTheme.typography.labelMedium, color = Chirkle.colors.muted) }
                }
            },
        )
    }) { padding ->
        val token = services.tokens.current
        val rows = remember(items) {
            buildList<Any> {
                var last = ""
                for (it in items) {
                    val m = month(it.sent)
                    if (m != last) { add(m); last = m }
                    add(it)
                }
            }
        }
        LazyVerticalGrid(
            GridCells.Adaptive(104.dp),
            Modifier.fillMaxSize().padding(padding),
            state = grid,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            items(rows, key = { if (it is MediaItem) "${it.message}/${it.file}" else "m-$it" }, span = { if (it is String) GridItemSpan(maxLineSpan) else GridItemSpan(1) }) { row ->
                if (row is String) {
                    Text(row, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 8.dp).semantics { heading() })
                    return@items
                }
                val it = row as MediaItem
                val label = buildString {
                    append(it.name.ifEmpty { "Attachment" })
                    if (it.video) append(", video")
                    it.author?.let { a -> append(", ").append(a.name) }
                    append(", ").append(Formats.time(it.sent))
                }
                Box(
                    Modifier
                        .aspectRatio(1f)
                        // A video without a poster: a dark tile, as in the room and on collections.
                        .background(if (it.video) Color(0xFF13111D) else MaterialTheme.colorScheme.surfaceContainerHigh)
                        .clickable(onClickLabel = "Open") { onOpen(it.message, it.file) }
                        .semantics { contentDescription = label },
                    contentAlignment = Alignment.Center,
                ) {
                    if (!it.video || it.poster) {
                        val url = if (it.video) services.api.mediaPosterUrl(it, token) else services.api.mediaUrl(it, token = token)
                        AsyncImage(Images.request(context, url), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    }
                    if (it.video) {
                        Box(Modifier.size(36.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
                            Icon(ChirkleIcons.Play, contentDescription = null, tint = Color.White, modifier = Modifier.size(22.dp))
                        }
                    }
                }
            }
            item(span = { GridItemSpan(maxLineSpan) }, key = "status") {
                Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    when {
                        loading -> CircularProgressIndicator(Modifier.size(28.dp))
                        failed -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("Couldn't load media.", color = Chirkle.colors.muted)
                            TextButton(onClick = ::load) { Text("Retry") }
                        }
                        items.isEmpty() -> Text("No photos or videos here yet.", color = Chirkle.colors.muted, textAlign = TextAlign.Center)
                    }
                }
            }
        }
    }
}
