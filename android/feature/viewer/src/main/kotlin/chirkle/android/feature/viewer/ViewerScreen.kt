// The image and video viewer (DESIGN.md §17.7): every image and video of the room around the one opened (or of a
// collection, §31.3), swiped through, pinch or double-tap to zoom. A tap shows or hides the bars. Videos play with Media3, which only this module
// carries (ANDROID.md §4.1, §11).
package chirkle.android.feature.viewer

import android.content.res.Resources
import androidx.compose.ui.res.stringResource
import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.geometry.isSpecified
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.compose.ContentFrame
import androidx.media3.ui.compose.state.rememberPlayPauseButtonState
import androidx.media3.ui.compose.state.rememberProgressStateWithTickInterval
import chirkle.android.data.lib.Pages
import chirkle.android.data.lib.attachmentName
import chirkle.android.data.lib.isMedia
import chirkle.android.data.lib.isVideo
import chirkle.android.data.model.Cursor
import chirkle.android.data.model.Message
import chirkle.android.data.model.SaveFrom
import chirkle.android.data.repo.ChirkleServices
import chirkle.android.ui.ChirkleIcons
import chirkle.android.ui.Formats
import chirkle.android.ui.Images
import chirkle.android.ui.LocalServices
import coil3.compose.SubcomposeAsyncImage
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlin.math.abs

/** One image or video: a message's file, or a collection item's ([item]: the message is the item as one). */
private data class Item(val m: Message, val file: String, val item: chirkle.android.data.model.CollectionItem? = null) {
    val key get() = "${m.id}/$file"
    val name get() = item?.name ?: m.attachmentName(file)
    val video get() = item?.video ?: isVideo(name)
    /** What Save copies: a message's file (a forward's original's, §21.3), or the item. */
    val from: SaveFrom get() = if (item != null) SaveFrom.Item(item.id) else SaveFrom.File(m.forwardOf.ifEmpty { m.id }, file)

    fun url(services: ChirkleServices, token: String?) =
        if (item != null) services.api.itemUrl(item.id, file, token = token) else services.api.fileUrl(m, file, token = token)
}

/** An item as the viewer takes it: a message of its own with one file. */
private fun asItem(it: chirkle.android.data.model.CollectionItem) =
    Item(Message(id = it.id, room = "", created = it.created, files = listOf(it.file), fileNames = mapOf(it.file to it.name)), it.file, it)

private const val MAX_ZOOM = 5f
private const val DOUBLE_TAP_ZOOM = 2.5f

@Composable
fun ViewerScreen(roomId: String, msgId: String, file: String, onClose: () -> Unit) {
    val services = LocalServices.current
    var items by remember(roomId, msgId) { mutableStateOf<List<Item>?>(null) }
    LaunchedEffect(roomId, msgId) {
        items = runCatching {
            val m = services.api.getMessage(msgId)
            val c = Cursor(m.created, m.id)
            coroutineScope {
                val before = async { services.api.page(Pages.withFiles(Pages.older(roomId, c))) }
                val after = async { services.api.page(Pages.withFiles(Pages.newer(roomId, c))) }
                (before.await().reversed() + m + after.await())
            }.flatMap { msg -> msg.files.filter { isMedia(msg.attachmentName(it)) }.map { Item(msg, it) } }
        }.getOrElse { listOf() }
    }
    // A message deleted meanwhile (or a forward whose original was) takes its images and videos with it; none left,
    // the viewer closes (the web's QA BUG-120; BUG-155).
    LaunchedEffect(roomId) {
        val changes = kotlinx.coroutines.channels.Channel<chirkle.android.data.api.Change<Message>>(kotlinx.coroutines.channels.Channel.UNLIMITED)
        val off = runCatching { services.api.subscribeMessages(roomId) { changes.trySend(it) } }.getOrNull() ?: return@LaunchedEffect
        try {
            for (c in changes) {
                val now = items ?: continue
                val m = c.record
                if (now.none { it.m.id == m.id }) continue
                val has = if (c.action == chirkle.android.data.api.Action.Delete || m.deleted) emptySet() else m.files.filter { isMedia(m.attachmentName(it)) }.toSet()
                val next = now.filter { it.m.id != m.id || it.file in has }
                if (next.size == now.size) continue
                items = next
                if (next.isEmpty()) onClose()
            }
        } finally {
            kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { runCatching { off() } }
        }
    }
    Viewer(items, "$msgId/$file", onClose)
}

/** A collection's items around the one opened (§31.3), oldest first as a room's are. */
@Composable
fun CollectionViewerScreen(collection: String, itemId: String, onClose: () -> Unit) {
    val services = LocalServices.current
    val items by produceState<List<Item>?>(null, collection, itemId) {
        value = runCatching {
            val (page, _) = services.api.collectionItems(collection)
            // The one opened, wherever it is: the newest page, or the pages around it.
            val at = page.firstOrNull { it.id == itemId } ?: run {
                var last: chirkle.android.data.model.CollectionItem? = null
                var found: chirkle.android.data.model.CollectionItem? = null
                while (found == null) {
                    val (more, has) = services.api.collectionItems(collection, last)
                    found = more.firstOrNull { it.id == itemId }
                    last = more.lastOrNull()
                    if (!has || last == null) break
                }
                found
            } ?: return@runCatching emptyList()
            coroutineScope {
                val newer = async { services.api.collectionItems(collection, at, newer = true).first }
                val older = async { services.api.collectionItems(collection, at).first }
                older.await().reversed() + at + newer.await()
            }.map(::asItem)
        }.getOrElse { listOf() }
    }
    Viewer(items, "$itemId/", onClose)
}

@Composable
private fun Viewer(items: List<Item>?, startKey: String, onClose: () -> Unit) {
    val services = LocalServices.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val signedIn = services.store.flow.collectAsState().value.user != null
    var saving by remember { mutableStateOf<SaveFrom?>(null) }
    var chrome by remember { mutableStateOf(true) }
    BackHandler(onBack = onClose)
    SystemBars(chrome)
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        val list = items
        when {
            list == null -> CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White)
            list.isEmpty() -> Text(stringResource(R.string.viewer_that_message_isnt_available_any), color = Color.White, modifier = Modifier.align(Alignment.Center))
            else -> {
                val start = list.indexOfFirst { it.key.startsWith(startKey) }.coerceAtLeast(0)
                val pager = rememberPagerState(initialPage = start) { list.size }
                HorizontalPager(pager, Modifier.fillMaxSize(), beyondViewportPageCount = 1, key = { list[it].key }) { page ->
                    val item = list[page]
                    if (item.video) {
                        Video(item, pager.currentPage == page, chrome) { chrome = !chrome }
                    } else {
                        Picture(item, pager.currentPage == page) { chrome = !chrome }
                    }
                }
                // The pager catches up with a shorter list (an item deleted) only at its next layout.
                val current = list[pager.currentPage.coerceAtMost(list.lastIndex)]
                AnimatedVisibility(chrome, Modifier.align(Alignment.BottomStart), enter = fadeIn(), exit = fadeOut()) {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.75f))))
                            .navigationBarsPadding()
                            .padding(start = 20.dp, end = 20.dp, top = 32.dp, bottom = 16.dp),
                    ) {
                        current.m.expand?.author?.let { Text(it.name, color = Color.White, style = MaterialTheme.typography.titleSmall) }
                        Text(
                            (if (current.item != null) stringResource(R.string.viewer_added) else "") + Formats.time(current.m.created) + " · " + current.name,
                            color = Color.White.copy(alpha = 0.75f),
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                AnimatedVisibility(chrome, Modifier.align(Alignment.TopStart), enter = fadeIn(), exit = fadeOut()) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.6f), Color.Transparent)))
                            .statusBarsPadding()
                            .padding(horizontal = 4.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onClick = onClose) { Icon(ChirkleIcons.Back, contentDescription = stringResource(R.string.viewer_close), tint = Color.White) }
                        Text(
                            if (list.size > 1) stringResource(R.string.viewer_of, pager.currentPage.coerceAtMost(list.lastIndex) + 1, list.size) else "",
                            color = Color.White,
                            style = MaterialTheme.typography.titleMedium,
                            modifier = Modifier.weight(1f),
                        )
                        if (signedIn) {
                            IconButton(onClick = { saving = current.from }) {
                                Icon(ChirkleIcons.Collection, contentDescription = stringResource(R.string.viewer_save_to_collection), tint = Color.White)
                            }
                        }
                        IconButton(onClick = { scope.launch { download(context, services, current) } }) {
                            Icon(ChirkleIcons.Download, contentDescription = stringResource(R.string.viewer_download), tint = Color.White)
                        }
                    }
                }
            }
        }
        saving?.let { from -> chirkle.android.ui.SaveToCollectionSheet(from) { saving = null } }
        if (list.isNullOrEmpty()) {
            IconButton(onClick = onClose, modifier = Modifier.align(Alignment.TopStart).statusBarsPadding().padding(4.dp)) {
                Icon(ChirkleIcons.Back, contentDescription = stringResource(R.string.viewer_close), tint = Color.White)
            }
        }
    }
}

/**
 * The system bars over black: light icons, and hidden with the viewer's own bars (swiped in from the edge, they show
 * for a while). Put back as they were on the way out.
 */
@Composable
private fun SystemBars(shown: Boolean) {
    val view = androidx.compose.ui.platform.LocalView.current
    val window = (view.context as? android.app.Activity)?.window ?: return
    val controller = remember(window, view) { androidx.core.view.WindowCompat.getInsetsController(window, view) }
    DisposableEffect(controller) {
        val light = controller.isAppearanceLightStatusBars
        val lightNav = controller.isAppearanceLightNavigationBars
        controller.isAppearanceLightStatusBars = false
        controller.isAppearanceLightNavigationBars = false
        controller.systemBarsBehavior = androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        onDispose {
            controller.show(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            controller.isAppearanceLightStatusBars = light
            controller.isAppearanceLightNavigationBars = lightNav
        }
    }
    LaunchedEffect(shown) {
        val bars = androidx.core.view.WindowInsetsCompat.Type.systemBars()
        if (shown) controller.show(bars) else controller.hide(bars)
    }
}

/**
 * An image that zooms. One finger pans only while zoomed in: at 1× the drag is left to the pager, so swiping to the
 * next image works. Two fingers always zoom.
 */
@Composable
private fun Picture(item: Item, active: Boolean, onTap: () -> Unit) {
    val services = LocalServices.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val token by produceState(services.tokens.current) { value = runCatching { services.tokens.ensure() }.getOrDefault("") }
    val scale = remember { Animatable(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var size by remember { mutableStateOf(IntSize.Zero) }
    // Swiped away: back to 1× for when it comes back.
    LaunchedEffect(active) { if (!active) { scale.snapTo(1f); offset = Offset.Zero } }

    fun clamp(o: Offset, s: Float): Offset {
        val maxX = (size.width * (s - 1f)) / 2f
        val maxY = (size.height * (s - 1f)) / 2f
        return Offset(o.x.coerceIn(-maxX, maxX), o.y.coerceIn(-maxY, maxY))
    }

    val url = item.url(services, token)
    SubcomposeAsyncImage(
        model = Images.request(context, url),
        contentDescription = item.name,
        contentScale = ContentScale.Fit,
        loading = { Box(Modifier.fillMaxSize()) { CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White) } },
        error = { Box(Modifier.fillMaxSize()) { Text(stringResource(R.string.viewer_couldnt_load_image), color = Color.White, modifier = Modifier.align(Alignment.Center)) } },
        modifier = Modifier
            .fillMaxSize()
            .onSizeChanged { size = it }
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = { onTap() },
                    onDoubleTap = { at ->
                        scope.launch {
                            if (scale.value > 1f) {
                                offset = Offset.Zero
                                scale.animateTo(1f)
                            } else {
                                // Zoom in on where you tapped.
                                val center = Offset(size.width / 2f, size.height / 2f)
                                offset = clamp((center - at) * (DOUBLE_TAP_ZOOM - 1f), DOUBLE_TAP_ZOOM)
                                scale.animateTo(DOUBLE_TAP_ZOOM)
                            }
                        }
                    },
                )
            }
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    do {
                        val event = awaitPointerEvent()
                        val fingers = event.changes.count { it.pressed }
                        if (fingers >= 2 || scale.value > 1f) {
                            val old = scale.value
                            val next = (old * event.calculateZoom()).coerceIn(1f, MAX_ZOOM)
                            val pan = event.calculatePan()
                            val centroid = event.calculateCentroid().takeIf { it.isSpecified } ?: Offset.Zero
                            val center = Offset(size.width / 2f, size.height / 2f)
                            // Keep the point under the fingers where it is while zooming.
                            val raw = offset + (centroid - center - offset) * (1 - next / old) + pan
                            val o = if (next == 1f) Offset.Zero else clamp(raw, next)
                            // One finger at the image's edge, moving sideways: the drag goes to the pager.
                            val stuck = fingers < 2 && abs(o.x - offset.x) < 0.5f && abs(pan.x) > abs(pan.y)
                            if (next != old) scope.launch { scale.snapTo(next) }
                            offset = o
                            if (!stuck) event.changes.forEach { if (it.positionChanged()) it.consume() }
                        }
                    } while (event.changes.any { it.pressed })
                }
            }
            .graphicsLayer(
                scaleX = scale.value,
                scaleY = scale.value,
                translationX = offset.x,
                translationY = offset.y,
                transformOrigin = TransformOrigin.Center,
            ),
    )
}

// ContentFrame is Media3's Compose surface, still marked unstable API.
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
private fun Video(item: Item, active: Boolean, chrome: Boolean, onTap: () -> Unit) {
    val services = LocalServices.current
    val context = LocalContext.current
    var failed by remember { mutableStateOf(false) }
    val player = remember { ExoPlayer.Builder(context).build().apply { repeatMode = Player.REPEAT_MODE_OFF } }
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                failed = true
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
            player.release()
        }
    }
    LaunchedEffect(item.key) {
        val token = runCatching { services.tokens.ensure() }.getOrDefault("")
        player.setMediaItem(MediaItem.fromUri(item.url(services, token).toString()))
        player.prepare()
    }
    // The page in view plays; one swiped away pauses.
    LaunchedEffect(active) { player.playWhenReady = active }
    Box(Modifier.fillMaxSize().pointerInput(Unit) { detectTapGestures(onTap = { onTap() }) }, contentAlignment = Alignment.Center) {
        ContentFrame(player, Modifier.fillMaxSize().semantics { contentDescription = item.name }, contentScale = ContentScale.Fit)
        if (failed) Text(stringResource(R.string.viewer_couldnt_play_this_video), color = Color.White)
        val playPause = rememberPlayPauseButtonState(player)
        AnimatedVisibility(chrome && !failed, enter = fadeIn(), exit = fadeOut()) {
            IconButton(
                onClick = playPause::onClick,
                enabled = playPause.isEnabled,
                modifier = Modifier.size(72.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.45f)),
            ) {
                Icon(
                    if (playPause.showPlay) ChirkleIcons.Play else ChirkleIcons.Pause,
                    contentDescription = if (playPause.showPlay) stringResource(R.string.viewer_play) else stringResource(R.string.viewer_pause),
                    tint = Color.White,
                    modifier = Modifier.size(40.dp),
                )
            }
        }
        AnimatedVisibility(chrome && !failed, Modifier.align(Alignment.BottomCenter), enter = fadeIn(), exit = fadeOut()) {
            Seek(player)
        }
    }
}

@Composable
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
private fun Seek(player: Player) {
    val res = LocalContext.current.resources
    val progress = rememberProgressStateWithTickInterval(player, 250)
    var dragging by remember { mutableStateOf<Float?>(null) }
    val duration = progress.durationMs.coerceAtLeast(0)
    val position = progress.currentPositionMs.coerceAtLeast(0)
    Row(
        Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 20.dp, end = 20.dp, bottom = 64.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(clock(dragging?.let { (it * duration).toLong() } ?: position), color = Color.White, style = MaterialTheme.typography.labelMedium)
        Slider(
            value = dragging ?: if (duration > 0) position.toFloat() / duration else 0f,
            onValueChange = { dragging = it },
            onValueChangeFinished = {
                dragging?.let { player.seekTo((it * duration).toLong()) }
                dragging = null
            },
            enabled = duration > 0,
            colors = SliderDefaults.colors(thumbColor = Color.White, activeTrackColor = Color.White, inactiveTrackColor = Color.White.copy(alpha = 0.3f)),
            modifier = Modifier.weight(1f).semantics { contentDescription = res.getString(R.string.viewer_position) },
        )
        Text(clock(duration), color = Color.White, style = MaterialTheme.typography.labelMedium)
    }
}

private fun clock(ms: Long): String {
    val s = ms / 1000
    return "%d:%02d".format(s / 60, s % 60)
}

/** Download a file with the system's download manager (a fresh file token in its URL, §17.3). */
private suspend fun download(context: Context, services: ChirkleServices, item: Item) {
    val token = runCatching { services.tokens.ensure() }.getOrDefault("")
    chirkle.android.ui.download(context, item.url(services, token).toString(), item.name)
}
