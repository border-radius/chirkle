// A message's attachments (DESIGN.md §17.5): images and videos as tiles of a fixed height (one large, or a row of up
// to four, the last saying "+N"), audio as a player, other files as chips that download. Thumbnails only in the list.
package chirkle.android.feature.room

import android.media.AudioAttributes
import android.media.MediaPlayer
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import chirkle.android.data.lib.attachmentName
import chirkle.android.data.lib.isAudio
import chirkle.android.data.lib.isGif
import chirkle.android.data.lib.isMedia
import chirkle.android.data.lib.isVideo
import chirkle.android.data.model.Message
import chirkle.android.ui.Chirkle
import chirkle.android.ui.ChirkleIcons
import chirkle.android.ui.Images
import chirkle.android.ui.LocalServices
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch
import java.io.File

/** Most image and video tiles a message shows; the last says how many more there are. */
const val MAX_TILES = 4

/**
 * A file of a message: a stored name on the server, or a local one while it is on its way ([local]: its path; "" for a
 * collection item being attached, whose picture is [thumb]).
 */
private data class Item(val name: String, val label: String, val local: String?, val thumb: okhttp3.HttpUrl? = null)

@Composable
fun Attachments(m: Message, actions: RowActions) {
    val services = LocalServices.current
    val items = if (m.status != null) {
        m.localFiles.map { Item(it.name, it.name, it.uri) } + m.localItems.map { Item(it.file, it.name, "", itemThumb(services, it)) }
    } else m.files.map { Item(it, m.attachmentName(it), null) }
    if (items.isEmpty()) return
    val media = items.filter { isMedia(it.label) }
    val others = items.filter { !isMedia(it.label) }
    Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (media.isNotEmpty()) {
            val one = media.size == 1
            // Wrapping, as the web's: in one row, a narrow phone cut off the last tiles and their "+N" (QA BUG-247).
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                media.take(MAX_TILES).forEachIndexed { i, f ->
                    val more = if (i == MAX_TILES - 1 && media.size > MAX_TILES) media.size - MAX_TILES else 0
                    Box {
                        if (one && (f.local == null || !isVideo(f.label))) {
                            SingleImage(m, f) { actions.onOpenMedia(m, f.name) }
                        } else {
                            MediaTile(m, f, if (one) 240 else 112, if (one) "800x480f" else "480x240f", more) { actions.onOpenMedia(m, f.name) }
                        }
                        if (f.local == null) {
                            m.fileSources[f.name]?.let { from -> actions.badge(from)?.let { b -> SourceBadge(b, Modifier.align(Alignment.BottomStart)) { actions.onCollection(from) } } }
                            if (more == 0) actions.onSave?.let { save -> chirkle.android.ui.SaveToCollectionButton("Save ${f.label} to collection", { save(m, f.name) }, Modifier.align(Alignment.TopEnd)) }
                        }
                    }
                }
            }
        }
        for (f in others) {
            if (isAudio(f.label) && f.local == null) AudioPlayer(m, f.name, f.label) else FileChip(f.label) { if (f.local == null) actions.onFile(m, f.name) }
        }
    }
}

/** A stored file's shape as the server says (§17.5), width / height; null until it knows, or for a local file. */
private fun ratioOf(m: Message, f: Item): Float? =
    if (f.local != null) null else m.fileDims[f.name]?.takeIf { it.size == 2 && it[0] > 0 && it[1] > 0 }?.let { it[0].toFloat() / it[1] }

@Composable
private fun MediaTile(m: Message, f: Item, height: Int, thumb: String, more: Int, onOpen: () -> Unit) {
    val services = LocalServices.current
    val context = LocalContext.current
    val video = isVideo(f.label)
    val max = if (height > 200) 320f else 112f
    // Known shape: the tile has its width before the image loads, so the row doesn't shift.
    val width = if (video) null else ratioOf(m, f)?.let { r -> Modifier.width((height * r).coerceIn(80f, max).dp) }
    Box(
        Modifier
            .height(height.dp)
            .widthIn(min = 80.dp, max = max.dp)
            .then(width ?: Modifier)
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .clickable(enabled = f.local == null, onClickLabel = "Open") { onOpen() }
            .semantics { contentDescription = f.label + if (more > 0) ", $more more" else "" },
        contentAlignment = Alignment.Center,
    ) {
        when {
            f.thumb != null && !video -> AsyncImage(Images.request(context, f.thumb), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(height.dp))
            f.local != null && !video -> AsyncImage(File(f.local), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.height(height.dp))
            video -> Box(Modifier.size(if (height > 200) 240.dp else 112.dp, height.dp).background(Color(0xFF13111D)), contentAlignment = Alignment.Center) {
                // The poster frame when the server has made one; a dark tile until then.
                if (f.local == null || f.thumb != null) {
                    AsyncImage(
                        Images.request(context, f.thumb ?: services.api.posterUrl(m, f.name, services.tokens.current)),
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                Box(Modifier.size(44.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
                    Icon(ChirkleIcons.Play, contentDescription = null, tint = Color.White, modifier = Modifier.size(28.dp))
                }
            }
            else -> {
                // A GIF shows the file itself: its server thumbnail is the first frame only.
                val url = services.api.fileUrl(m, f.name, if (isGif(f.label)) null else thumb, services.tokens.current)
                AsyncImage(Images.request(context, url), contentDescription = null, contentScale = if (height > 200) ContentScale.Fit else ContentScale.Crop, modifier = Modifier.height(height.dp))
            }
        }
        if (more > 0) {
            Box(Modifier.matchParentSize().background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
                Text("+$more", color = Color.White, style = MaterialTheme.typography.titleLarge)
            }
        }
    }
}

/**
 * One image or video alone: shown whole, in its own shape, at most 320 × 240 dp (the server's `file_dims` say it
 * before it loads, §17.5; a placeholder of 240 × 160 until it is known). A video shows its poster, or a dark tile until
 * the server has made one, with a play button.
 */
@Composable
private fun SingleImage(m: Message, f: Item, onOpen: () -> Unit) {
    val services = LocalServices.current
    val context = LocalContext.current
    val video = isVideo(f.label)
    val url = when {
        f.thumb != null -> f.thumb
        f.local != null -> null
        video -> services.api.posterUrl(m, f.name, services.tokens.current)
        else -> services.api.fileUrl(m, f.name, if (isGif(f.label)) null else "800x480f", services.tokens.current)
    }
    val key = url?.let { Images.cacheKey(it) } ?: f.local.orEmpty()
    var ratio by remember(key) { mutableStateOf(Images.ratios[key] ?: ratioOf(m, f)) }
    val shape = RoundedCornerShape(12.dp)
    val size = ratio?.let { r ->
        // The largest box of that shape within 320 × 240.
        val h = minOf(240f, 320f / r).coerceAtLeast(48f)
        Modifier.height(h.dp).width((h * r).coerceIn(48f, 320f).dp)
    } ?: Modifier.size(240.dp, 160.dp)
    Box(
        Modifier
            .then(size)
            .clip(shape)
            .background(if (video) Color(0xFF13111D) else MaterialTheme.colorScheme.surfaceContainerHigh)
            .clickable(enabled = f.local == null, onClickLabel = "Open") { onOpen() }
            .semantics { contentDescription = f.label + if (video) ", video" else "" },
        contentAlignment = Alignment.Center,
    ) {
        AsyncImage(
            model = if (url != null) Images.request(context, url) else File(f.local!!),
            contentDescription = null,
            contentScale = ContentScale.Crop,
            onSuccess = { s ->
                val img = s.result.image
                if (img.width > 0 && img.height > 0) {
                    val r = img.width.toFloat() / img.height
                    Images.ratios[key] = r
                    ratio = r
                }
            },
            modifier = Modifier.fillMaxSize(),
        )
        if (video) {
            Box(Modifier.size(48.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
                Icon(ChirkleIcons.Play, contentDescription = null, tint = Color.White, modifier = Modifier.size(30.dp))
            }
        }
    }
}

/** A collection item's picture while the message attaching it is on its way: its thumbnail, or a video's poster. */
private fun itemThumb(services: chirkle.android.data.repo.ChirkleServices, it: chirkle.android.data.model.CollectionItem): okhttp3.HttpUrl? = when {
    it.video && it.poster -> services.api.itemPosterUrl(it.id, it.file, services.tokens.current)
    it.video -> null
    else -> services.api.itemUrl(it.id, it.file, "240x240", services.tokens.current)
}

/**
 * Over a file attached from a collection (§31.3): the collection's name, a link to it, when it is public or yours (🔒
 * after a private one of yours); "Private collection", not a link, when it is someone else's private one.
 */
@Composable
private fun SourceBadge(b: chirkle.android.data.model.Badge, modifier: Modifier, onOpen: () -> Unit) {
    val shape = RoundedCornerShape(8.dp)
    Row(
        modifier
            .padding(6.dp)
            .clip(shape)
            .background(Color.Black.copy(alpha = 0.6f))
            .then(if (b.private) Modifier else Modifier.clickable(onClickLabel = "Open the collection", onClick = onOpen))
            .padding(horizontal = 6.dp, vertical = 3.dp)
            .widthIn(max = 160.dp)
            .semantics(mergeDescendants = true) { contentDescription = if (b.private) "From a private collection" else "From the collection ${b.name}" + if (b.public) "" else ", private" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(ChirkleIcons.Collection, contentDescription = null, tint = Color.White, modifier = Modifier.size(12.dp))
        Text(if (b.private) "Private collection" else b.name, color = Color.White, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (!b.private && !b.public) Icon(ChirkleIcons.Lock, contentDescription = null, tint = Color.White, modifier = Modifier.size(11.dp))
    }
}

private fun Modifier.matchParentSize() = this.then(Modifier.fillMaxSize())

@Composable
private fun FileChip(label: String, onClick: () -> Unit) {
    Row(
        Modifier
            .heightIn(min = 40.dp)
            .clip(RoundedCornerShape(10.dp))
            .border(1.dp, Chirkle.colors.border, RoundedCornerShape(10.dp))
            .clickable(onClickLabel = "Download", onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp)
            .widthIn(max = 320.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(ChirkleIcons.File, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(8.dp))
        Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f, fill = false))
        Spacer(Modifier.width(8.dp))
        Icon(ChirkleIcons.Download, contentDescription = null, tint = Chirkle.colors.muted, modifier = Modifier.size(18.dp))
    }
}

/** An inline audio player (§17.5): the platform's MediaPlayer, so the viewer's Media3 stays out of the room. */
@Composable
private fun AudioPlayer(m: Message, name: String, label: String) {
    val services = LocalServices.current
    val scope = rememberCoroutineScope()
    var player by remember { mutableStateOf<MediaPlayer?>(null) }
    var playing by remember { mutableStateOf(false) }
    var preparing by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var position by remember { mutableStateOf(0) }
    var duration by remember { mutableStateOf(0) }
    DisposableEffect(m.id, name) { onDispose { player?.release() } }
    // Where it is, four times a second while it plays.
    androidx.compose.runtime.LaunchedEffect(playing) {
        while (playing) {
            player?.let { p -> runCatching { position = p.currentPosition } }
            kotlinx.coroutines.delay(250)
        }
    }
    Row(
        Modifier
            .clip(RoundedCornerShape(24.dp))
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .border(1.dp, Chirkle.colors.border, RoundedCornerShape(24.dp))
            .padding(end = 16.dp)
            .widthIn(min = 220.dp, max = 320.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        androidx.compose.material3.FilledIconButton(
            onClick = {
                val p = player
                when {
                    p != null && playing -> { runCatching { p.pause() }; playing = false }
                    p != null && !preparing -> runCatching { p.start(); playing = true }.onFailure { failed = true; player = null; p.release() }
                    p == null -> scope.launch {
                        preparing = true
                        failed = false
                        val token = runCatching { services.tokens.ensure() }.getOrDefault("")
                        val mp = MediaPlayer()
                        mp.setAudioAttributes(AudioAttributes.Builder().setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                        runCatching {
                            mp.setDataSource(services.api.fileUrl(m, name, token = token).toString())
                            mp.setOnPreparedListener {
                                preparing = false
                                duration = it.duration.coerceAtLeast(0)
                                it.start()
                                playing = true
                            }
                            mp.setOnCompletionListener { playing = false; position = 0; it.seekTo(0) }
                            // An errored player throws on start(): it goes, and the next tap tries afresh (a new token).
                            mp.setOnErrorListener { p, _, _ ->
                                failed = true
                                playing = false
                                preparing = false
                                if (player === p) player = null
                                p.release()
                                true
                            }
                            mp.prepareAsync()
                            player = mp
                        }.onFailure { failed = true; preparing = false; mp.release() }
                    }
                }
            },
            modifier = Modifier.padding(6.dp).size(36.dp),
        ) {
            Icon(if (playing) ChirkleIcons.Pause else ChirkleIcons.Play, contentDescription = if (playing) "Pause $label" else "Play $label", modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.width(6.dp))
        Column(Modifier.weight(1f, fill = false)) {
            Text(if (failed) "Couldn't play $label" else label, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
            if (duration > 0) {
                androidx.compose.material3.LinearProgressIndicator(
                    progress = { (position.toFloat() / duration).coerceIn(0f, 1f) },
                    modifier = Modifier.padding(top = 4.dp).fillMaxWidth().height(3.dp).clip(RoundedCornerShape(2.dp)),
                    drawStopIndicator = {},
                    gapSize = 0.dp,
                )
                Text("${clock(position)} / ${clock(duration)}", style = MaterialTheme.typography.labelSmall, color = Chirkle.colors.muted, modifier = Modifier.padding(top = 2.dp))
            } else if (preparing) {
                Text("Loading…", style = MaterialTheme.typography.labelSmall, color = Chirkle.colors.muted)
            }
        }
    }
}

private fun clock(ms: Int): String {
    val s = ms / 1000
    return "%d:%02d".format(s / 60, s % 60)
}
