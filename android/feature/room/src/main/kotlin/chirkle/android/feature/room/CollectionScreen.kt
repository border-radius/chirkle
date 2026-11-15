// A collection's page (DESIGN.md §31.3; web/src/views/collection/lazy.ts mountCollection): its name, whose it is,
// Public or Private and how many items; its items as square tiles, newest first under month headings, 60 at a time,
// those added since you last looked ringed. The owner uploads, renames, makes it public or private, deletes it and
// takes items out; others subscribe. The page follows the store: what is added meanwhile comes in at the top.
package chirkle.android.feature.room

import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import chirkle.android.data.api.ApiError
import chirkle.android.data.api.reasonOf
import chirkle.android.data.model.CollectionItem
import chirkle.android.data.model.CollectionMeta
import chirkle.android.data.model.MediaCollection
import chirkle.android.data.model.SaveFrom
import chirkle.android.data.pb.UploadFile
import chirkle.android.ui.Chirkle
import chirkle.android.ui.ChirkleIcons
import chirkle.android.ui.ItemPicture
import chirkle.android.ui.LocalServices
import chirkle.android.ui.SaveToCollectionButton
import chirkle.android.ui.SaveToCollectionSheet
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import java.io.File

/** What can be uploaded into a collection: images and videos (lib/files.ts), at most 20 MB. */
private val MEDIA = Regex("\\.(jpe?g|png|gif|webp|avif|mp4|m4v|webm|mov|ogv)$", RegexOption.IGNORE_CASE)
private const val MAX_BYTES = 20L * 1024 * 1024

/** A picked file, streamed from its content URI when it is sent. */
private class Picked(val uri: Uri, val name: String, val type: String, val size: Long) {
    /** The compressed video, once it is (VideoPrep). */
    var prepared: VideoPrep.Result.Done? = null
}

/** A file that isn't uploaded, and why. */
private class Skip(why: String) : Exception(why)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CollectionScreen(id: String, onOpen: (itemId: String) -> Unit, onBack: () -> Unit) {
    val res = LocalContext.current.resources
    val services = LocalServices.current
    val context = LocalContext.current
    val app by services.store.flow.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val me = app.user
    var info by remember { mutableStateOf<CollectionMeta?>(null) }
    var gone by remember { mutableStateOf(false) }
    /** Up to when you had seen it (a collection you follow), as the page opened: what is newer is new. */
    var seenAt by remember { mutableStateOf<String?>(null) }
    val items = remember { mutableStateListOf<CollectionItem>() }
    /** Items added while the page is open: marked new too. */
    val added = remember { mutableStateListOf<String>() }
    var more by remember { mutableStateOf(true) }
    var loading by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var fresh by remember { mutableStateOf(0) }
    var notice by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf<SaveFrom?>(null) }
    var renaming by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var following by remember { mutableStateOf(false) }
    val grid = rememberLazyGridState()
    val mine = me != null && info?.owner == me.id
    val subscribed = app.collections?.subs?.any { it.id == id } == true

    fun isNew(it: CollectionItem) = it.id in added || (!seenAt.isNullOrEmpty() && it.created > seenAt!!)

    fun load() {
        if (loading || !more) return
        loading = true
        failed = false
        scope.launch {
            runCatching { services.api.collectionItems(id, items.lastOrNull()) }
                .onSuccess { (page, m) ->
                    val shown = items.map { it.id }.toSet()
                    items += page.filter { it.id !in shown }
                    more = m
                }
                .onFailure { failed = true }
            loading = false
        }
    }

    /** The newest item's `created`, sent as seen while the app is in view (the sidebar's count goes). */
    var unseen by remember { mutableStateOf("") }
    fun markSeen() {
        if (unseen.isEmpty() || services.store.get().away || services.store.get().collections?.subs?.any { it.id == id } != true) return
        val at = unseen
        unseen = ""
        services.collections.seen(id, at)
    }

    LaunchedEffect(id) {
        // Your subscription's seen_at decides what is new: wait for the store to have it (just after a start).
        if (me != null && services.store.get().collections == null) withTimeoutOrNull(2000) { services.store.flow.first { it.collections != null } }
        seenAt = services.store.get().collections?.subs?.firstOrNull { it.id == id }?.seenAt.orEmpty()
        try {
            info = services.api.collection(id)
        } catch (e: Exception) {
            if ((e as? ApiError)?.status == 404 || (e as? ApiError)?.status == 403) gone = true else notice = res.getString(R.string.room_couldnt_open_the_collection, reasonOf(e))
            return@LaunchedEffect
        }
        loading = true
        runCatching { services.api.collectionItems(id) }
            .onSuccess { (page, m) ->
                items.clear()
                items += page
                more = m
                fresh = page.count(::isNew)
                unseen = page.firstOrNull()?.created.orEmpty()
            }
            .onFailure { failed = true }
        loading = false
        markSeen()
    }
    LaunchedEffect(app.away) { markSeen() }
    LaunchedEffect(grid) {
        snapshotFlow { grid.layoutInfo.visibleItemsInfo.lastOrNull()?.index to grid.layoutInfo.totalItemsCount }
            .distinctUntilChanged()
            .collect { (last, total) -> if (info != null && items.isNotEmpty() && last != null && last >= total - 12 && !failed) load() }
    }

    /** Items added while the page is open: at the top, marked new. More than a page: from the start again. */
    suspend fun newer() {
        val top = items.firstOrNull()
        val got = runCatching { services.api.collectionItems(id, top, newer = top != null) }.getOrNull() ?: return
        val (page, m) = got
        if (top == null || m) {
            items.clear()
            items += if (top == null) page else services.api.collectionItems(id).first
            more = true
            return
        }
        val shown = items.map { it.id }.toSet()
        val newOnes = page.filter { it.id !in shown }
        added += newOnes.map { it.id }
        items.addAll(0, newOnes.reversed())
    }

    /** Taken out elsewhere (the save sheet, another device): those shown that are gone leave the grid. */
    suspend fun prune() {
        val oldest = items.lastOrNull() ?: return
        val ids = runCatching { services.api.itemIdsSince(id, oldest) }.getOrNull() ?: return
        items.removeAll { it.id !in ids }
    }

    // Follow the store: a collection of yours or one you follow (§31.3).
    val listed: MediaCollection? = app.collections?.find(id)
    val last = remember { arrayOfNulls<MediaCollection>(1) }
    LaunchedEffect(listed) {
        val c = listed
        val prev = last[0]
        last[0] = c
        if (c != null) {
            info = info?.copy(name = c.name, public = c.public, items = c.items)
            if (prev != null && c.lastAdded != prev.lastAdded) newer()
            if (prev != null && c.items < prev.items + if (c.lastAdded != prev.lastAdded) 1 else 0) prune()
            if (c.new > 0) {
                unseen = c.lastAdded
                markSeen()
            }
        } else if (prev != null) {
            // Gone from the list: made private, deleted, or no longer followed.
            try {
                val m = services.api.collection(id)
                info = info?.copy(name = m.name, public = m.public, items = m.items) ?: m
            } catch (e: ApiError) {
                if (e.status == 404) gone = true
            }
        }
    }

    // ---- uploading (the owner's): one at a time, with the percentage sent
    val queue = remember { ArrayDeque<Picked>() }
    var uploading by remember { mutableStateOf(false) }
    val failures = remember { mutableListOf<String>() }
    fun upload(picked: List<Picked>) {
        for (f in picked) {
            when {
                !MEDIA.containsMatchIn(f.name) -> failures += res.getString(R.string.room_not_an_image_or_video, f.name)
                // A video may be bigger: it is compressed first (VideoPrep).
                f.size > (if (f.type.startsWith("video/")) VideoPrep.MAX_SOURCE_BYTES else MAX_BYTES) -> failures += res.getString(R.string.room_larger_than_20_mb_2, f.name)
                else -> queue.addLast(f)
            }
        }
        if (uploading) return
        if (queue.isEmpty()) {
            notice = if (failures.isEmpty()) "" else res.getString(R.string.room_couldnt_upload, failures.joinToString("; "))
            failures.clear()
            return
        }
        uploading = true
        scope.launch {
            var sent = 0
            while (queue.isNotEmpty()) {
                val f = queue.first()
                val at = res.getString(R.string.room_uploading_of, sent + 1, sent + queue.size)
                notice = at
                try {
                    // A video is compressed first (VideoPrep), once: a 429 sends the same file again.
                    if (f.type.startsWith("video/") && f.prepared == null) {
                        val out = File(context.cacheDir, "upload-${java.util.UUID.randomUUID()}.mp4")
                        val doing = res.getString(R.string.room_compressing_of, sent + 1, sent + queue.size)
                        notice = doing
                        when (val r = VideoPrep.prepare(context, f.uri, f.name, f.size, out) { x -> notice = "$doing $x%" }) {
                            is VideoPrep.Result.Done -> f.prepared = r
                            VideoPrep.Result.TooLong -> throw Skip(res.getString(R.string.room_too_long_to_send_about, VideoPrep.maxMinutes()))
                            VideoPrep.Result.Failed -> Unit
                        }
                        notice = at
                    }
                    val p = f.prepared
                    val size = p?.file?.length() ?: f.size
                    if (size > MAX_BYTES) throw Skip(res.getString(R.string.room_larger_than_20_mb))
                    val body = object : RequestBody() {
                        override fun contentType() = (if (p != null) "video/mp4" else f.type).toMediaTypeOrNull()
                        override fun contentLength() = size
                        override fun writeTo(sink: BufferedSink) {
                            (p?.file?.inputStream() ?: context.contentResolver.openInputStream(f.uri)!!).source().use { sink.writeAll(it) }
                        }
                    }
                    services.api.uploadItem(id, UploadFile(p?.name ?: f.name, if (p != null) "video/mp4" else f.type, body)) { x -> notice = "$at ${(x * 100).toInt()}%" }
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) {
                        f.prepared?.file?.delete()
                        throw e
                    }
                    // Too many at once (the server's rate limit): wait, then the same one again.
                    if ((e as? ApiError)?.status == 429) {
                        notice = res.getString(R.string.room_waiting_for_the_server)
                        delay(10_000)
                        continue
                    }
                    failures += "${f.name}: ${if (e is Skip) e.message else reasonOf(e)}"
                }
                f.prepared?.file?.delete()
                queue.removeFirst()
                sent++
                services.collections.refresh()
            }
            uploading = false
            notice = if (failures.isEmpty()) "" else res.getString(R.string.room_couldnt_upload, failures.joinToString("; "))
            failures.clear()
        }
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(20)) { uris ->
        upload(uris.mapNotNull { describe(context, it) })
    }

    fun change(name: String? = null, public: Boolean? = null, then: () -> Unit = {}) {
        scope.launch {
            try {
                val m = services.api.updateCollection(id, name, public)
                info = info?.copy(name = m.name, public = m.public)
                notice = ""
                services.collections.refresh()
                then()
            } catch (e: Exception) {
                notice = res.getString(R.string.room_couldnt_save, reasonOf(e))
            }
        }
    }

    // Dragged to the right, the collection goes back, as a room does (§40, §52).
    Scaffold(modifier = Modifier.swipeBack(enabled = true, onBack = onBack), topBar = {
        TopAppBar(
            navigationIcon = { IconButton(onClick = onBack) { Icon(ChirkleIcons.Back, contentDescription = stringResource(R.string.room_back)) } },
            title = {
                val i = info
                if (i != null && !gone) {
                    Column {
                        Text(i.name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() })
                        val owner = i.expand?.owner?.name.orEmpty()
                        Text(
                            listOfNotNull(if (mine) stringResource(R.string.room_yours) else owner.takeIf { it.isNotEmpty() }?.let { stringResource(R.string.room_by, it) }, if (i.public) stringResource(R.string.room_public) else stringResource(R.string.room_private_2), pluralStringResource(R.plurals.room_items, i.items, i.items)).joinToString(" · "),
                            style = MaterialTheme.typography.labelMedium,
                            color = Chirkle.colors.muted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                } else Text(stringResource(R.string.room_collection))
            },
            actions = {
                val i = info
                if (i != null && !gone && mine) {
                    IconButton(onClick = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) }, enabled = !uploading) {
                        Icon(ChirkleIcons.Upload, contentDescription = stringResource(R.string.room_upload))
                    }
                    Box {
                        IconButton(onClick = { menu = true }) { Icon(ChirkleIcons.More, contentDescription = stringResource(R.string.room_collection_actions)) }
                        DropdownMenu(menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(text = { Text(stringResource(R.string.room_rename)) }, leadingIcon = { Icon(ChirkleIcons.Edit, contentDescription = null) }, onClick = { menu = false; renaming = true })
                            DropdownMenuItem(
                                text = { Text(if (i.public) stringResource(R.string.room_make_private) else stringResource(R.string.room_make_public)) },
                                leadingIcon = { Icon(if (i.public) ChirkleIcons.Lock else ChirkleIcons.Globe, contentDescription = null) },
                                onClick = { menu = false; change(public = !i.public) },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.room_delete), color = MaterialTheme.colorScheme.error) },
                                leadingIcon = { Icon(ChirkleIcons.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                                onClick = { menu = false; deleting = true },
                            )
                        }
                    }
                }
            },
        )
    }) { padding ->
        if (gone) {
            Column(Modifier.fillMaxSize().padding(padding).padding(32.dp), verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(ChirkleIcons.Collection, contentDescription = null, tint = Chirkle.colors.muted, modifier = Modifier.size(40.dp))
                Text(stringResource(R.string.room_this_collection_doesnt_exist), style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.room_it_may_be_private_or), color = Chirkle.colors.muted)
                TextButton(onClick = onBack) { Text(stringResource(R.string.room_back)) }
            }
            return@Scaffold
        }
        val rows by remember {
            androidx.compose.runtime.derivedStateOf {
                buildList<Any> {
                    var m = ""
                    for (it in items) {
                        val mo = month(it.created)
                        if (mo != m) { add(mo); m = mo }
                        add(it)
                    }
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
            item(span = { GridItemSpan(maxLineSpan) }, key = "head") {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val i = info
                    if (i != null && !mine && me != null && (i.public || subscribed)) {
                        val label = if (subscribed) stringResource(R.string.room_unsubscribe) else stringResource(R.string.room_subscribe)
                        val run = {
                            following = true
                            scope.launch {
                                try {
                                    services.api.follow(id, !subscribed)
                                    services.collections.reload()
                                } catch (e: Exception) {
                                    notice = res.getString(if (subscribed) R.string.room_couldnt_unsubscribe else R.string.room_couldnt_subscribe, reasonOf(e))
                                }
                                following = false
                            }
                            Unit
                        }
                        if (subscribed) OutlinedButton(onClick = run, enabled = !following) { Text(label) }
                        else FilledTonalButton(onClick = run, enabled = !following) { Text(label) }
                    }
                    if (notice.isNotEmpty()) Text(notice, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                    if (fresh > 0) Text(stringResource(R.string.room_new_since_your_last_visit, if (fresh >= 60) "60+" else fresh), color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.titleSmall)
                }
            }
            items(rows, key = { if (it is CollectionItem) it.id else "m-$it" }, span = { if (it is String) GridItemSpan(maxLineSpan) else GridItemSpan(1) }) { row ->
                if (row is String) {
                    Text(row, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 8.dp).semantics { heading() })
                    return@items
                }
                val it = row as CollectionItem
                val new = isNew(it)
                Box(Modifier.aspectRatio(1f)) {
                    ItemPicture(
                        it,
                        Modifier
                            .fillMaxSize()
                            .clickable(onClickLabel = stringResource(R.string.room_open)) { onOpen(it.id) }
                            .semantics { contentDescription = it.name + (if (it.video) res.getString(R.string.room_video) else "") + if (new) res.getString(R.string.room_new) else "" },
                    )
                    if (new) {
                        Box(Modifier.matchParentSize().border(3.dp, MaterialTheme.colorScheme.primary))
                        Box(Modifier.align(Alignment.BottomEnd).padding(8.dp).size(10.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary))
                    }
                    if (me != null) SaveToCollectionButton(stringResource(R.string.room_save_to_collection, it.name), { saving = SaveFrom.Item(it.id) }, Modifier.align(Alignment.TopEnd))
                    if (mine) {
                        IconButton(
                            onClick = {
                                scope.launch {
                                    try {
                                        services.api.removeItem(it.id)
                                        items.remove(it)
                                        info = info?.let { i -> i.copy(items = (i.items - 1).coerceAtLeast(0)) }
                                        services.collections.refresh()
                                    } catch (e: Exception) {
                                        notice = res.getString(R.string.room_couldnt_remove_it, reasonOf(e))
                                    }
                                }
                            },
                            modifier = Modifier.align(Alignment.TopStart).size(36.dp),
                        ) {
                            Box(Modifier.size(28.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.55f)), contentAlignment = Alignment.Center) {
                                Icon(ChirkleIcons.Close, contentDescription = stringResource(R.string.room_remove_from_the_collection, it.name), tint = Color.White, modifier = Modifier.size(16.dp))
                            }
                        }
                    }
                }
            }
            item(span = { GridItemSpan(maxLineSpan) }, key = "status") {
                Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    when {
                        loading || info == null && notice.isEmpty() -> CircularProgressIndicator(Modifier.size(28.dp))
                        failed -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(stringResource(R.string.room_couldnt_load_the_collection), color = Chirkle.colors.muted)
                            TextButton(onClick = ::load) { Text(stringResource(R.string.room_retry)) }
                        }
                        items.isEmpty() && !more -> Text(
                            if (mine) stringResource(R.string.room_nothing_here_yet_upload_images) else stringResource(R.string.room_nothing_here_yet),
                            color = Chirkle.colors.muted,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
        }
    }

    saving?.let { from -> SaveToCollectionSheet(from) { saving = null } }
    if (renaming) {
        var name by remember { mutableStateOf(info?.name.orEmpty()) }
        AlertDialog(
            onDismissRequest = { renaming = false },
            title = { Text(stringResource(R.string.room_rename_collection)) },
            text = { OutlinedTextField(name, { name = it }, label = { Text(stringResource(R.string.room_collection_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth()) },
            confirmButton = { Button(onClick = { change(name = name) { renaming = false } }, enabled = name.isNotBlank()) { Text(stringResource(R.string.room_save)) } },
            dismissButton = { TextButton(onClick = { renaming = false }) { Text(stringResource(R.string.room_cancel)) } },
        )
    }
    if (deleting) {
        val i = info
        AlertDialog(
            onDismissRequest = { deleting = false },
            title = { Text(stringResource(R.string.room_delete_collection)) },
            text = { Text(if ((i?.items ?: 0) > 0) pluralStringResource(R.plurals.room_delete_collection_items, i!!.items, i.name, i.items) else stringResource(R.string.room_delete_collection_q, i?.name.orEmpty())) },
            confirmButton = {
                TextButton(onClick = {
                    deleting = false
                    scope.launch {
                        try {
                            services.api.deleteCollection(id)
                            services.collections.refresh()
                            onBack()
                        } catch (e: Exception) {
                            notice = res.getString(R.string.room_couldnt_delete_it, reasonOf(e))
                        }
                    }
                }) { Text(stringResource(R.string.room_delete_collection), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { deleting = false }) { Text(stringResource(R.string.room_cancel)) } },
        )
    }
}

/** A picked file's name, type and size; a name without an image or video extension gets its type's. */
private fun describe(context: android.content.Context, uri: Uri): Picked? = runCatching {
    val cr = context.contentResolver
    var name = "file"
    var size = -1L
    cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
            name = c.getString(0) ?: name
            size = if (c.isNull(1)) -1L else c.getLong(1)
        }
    }
    val type = cr.getType(uri) ?: "application/octet-stream"
    if (!MEDIA.containsMatchIn(name)) MimeTypeMap.getSingleton().getExtensionFromMimeType(type)?.let { name = "$name.$it" }
    Picked(uri, name, type, size)
}.getOrNull()
