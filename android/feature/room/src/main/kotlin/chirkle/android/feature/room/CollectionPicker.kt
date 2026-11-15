// Attach from collections (DESIGN.md §31.3; web/src/views/collection/lazy.ts openPicker): your collections and those
// you follow, one at a time as a grid; pick up to what the message still takes and they join the composer's tray.
package chirkle.android.feature.room

import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import chirkle.android.data.model.CollectionItem
import chirkle.android.ui.Chirkle
import chirkle.android.ui.ChirkleIcons
import chirkle.android.ui.ChirkleSheet
import chirkle.android.ui.ItemPicture
import chirkle.android.ui.LocalServices
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/** Up to [max] items picked from a collection: [onPick] gets them in the order they were picked. */
@Composable
fun CollectionPickerSheet(max: Int, onPick: (List<CollectionItem>) -> Unit, onDismiss: () -> Unit) {
    val services = LocalServices.current
    val app by services.store.flow.collectAsStateWithLifecycle()
    val all = app.collections?.let { it.mine + it.subs }.orEmpty()
    var chosen by remember { mutableStateOf(all.firstOrNull()?.id) }
    LaunchedEffect(all.isEmpty()) { if (chosen == null) chosen = all.firstOrNull()?.id }
    val picked = remember { mutableStateListOf<CollectionItem>() }

    ChirkleSheet(onDismiss) {
        Row(Modifier.padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(ChirkleIcons.Collection, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Text(stringResource(R.string.room_attach_from_collections), style = MaterialTheme.typography.titleMedium)
        }
        if (all.isEmpty()) {
            Text(
                if (app.collections == null) stringResource(R.string.room_loading) else stringResource(R.string.room_you_have_no_collections_yet),
                color = Chirkle.colors.muted,
                modifier = Modifier.padding(20.dp),
            )
            return@ChirkleSheet
        }
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(all, key = { it.id }) { c ->
                FilterChip(
                    selected = chosen == c.id,
                    onClick = { chosen = c.id },
                    label = { Text(if (c.owner != null) "${c.name} · ${c.owner!!.name}" else c.name, maxLines = 1) },
                )
            }
        }
        chosen?.let { id ->
            // The grid takes what the footer leaves (small screens keep Attach in view).
            androidx.compose.runtime.key(id) { PickGrid(id, picked, max, Modifier.weight(1f, fill = false).heightIn(min = 120.dp, max = 420.dp)) }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                when {
                    picked.isNotEmpty() -> stringResource(R.string.room_picked, picked.size) + if (picked.size >= max) stringResource(R.string.room_the_most_a_message_takes) else ""
                    max == 0 -> stringResource(R.string.room_the_message_has_all_the)
                    else -> ""
                },
                color = Chirkle.colors.muted,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite },
            )
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.room_cancel)) }
            Button(onClick = { onPick(picked.toList()) }, enabled = picked.isNotEmpty()) { Text(if (picked.isEmpty()) stringResource(R.string.room_attach_2) else stringResource(R.string.room_attach, picked.size)) }
        }
    }
}

@Composable
private fun PickGrid(collection: String, picked: MutableList<CollectionItem>, max: Int, modifier: Modifier) {
    val res = LocalContext.current.resources
    val services = LocalServices.current
    // On the main thread, as the services are: the sheet is another window, and its state must reach it.
    val scope = rememberCoroutineScope { services.main }
    val items = remember { mutableStateListOf<CollectionItem>() }
    var more by remember { mutableStateOf(true) }
    var loading by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    val grid = rememberLazyGridState()
    fun load() {
        if (loading || !more) return
        loading = true
        failed = false
        scope.launch {
            runCatching { services.api.collectionItems(collection, items.lastOrNull()) }
                .onSuccess { (page, m) -> items += page; more = m }
                .onFailure { failed = true }
            loading = false
        }
    }
    LaunchedEffect(Unit) { load() }
    LaunchedEffect(grid) {
        snapshotFlow { grid.layoutInfo.visibleItemsInfo.lastOrNull()?.index to grid.layoutInfo.totalItemsCount }
            .distinctUntilChanged()
            .collect { (last, total) -> if (last != null && last >= total - 12 && !failed) load() }
    }
    LazyVerticalGrid(
        GridCells.Adaptive(96.dp),
        modifier.fillMaxWidth().padding(top = 8.dp),
        state = grid,
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        items(items, key = { it.id }) { it ->
            val on = picked.any { p -> p.id == it.id }
            Box(
                Modifier
                    .aspectRatio(1f)
                    .toggleable(on, role = Role.Checkbox) { now ->
                        if (!now) picked.removeAll { p -> p.id == it.id } else if (picked.size < max) picked += it
                    }
                    .semantics { contentDescription = it.name + if (it.video) res.getString(R.string.room_video) else "" },
            ) {
                ItemPicture(it, Modifier.fillMaxSize())
                if (on) {
                    Box(Modifier.matchParentSize().border(3.dp, MaterialTheme.colorScheme.primary))
                    Box(
                        Modifier.align(Alignment.TopEnd).padding(4.dp).size(22.dp).background(MaterialTheme.colorScheme.primary, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) { Icon(ChirkleIcons.Check, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(16.dp)) }
                }
            }
        }
        item(span = { GridItemSpan(maxLineSpan) }, key = "status") {
            Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                when {
                    loading -> CircularProgressIndicator(Modifier.size(24.dp))
                    failed -> Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(stringResource(R.string.room_couldnt_load_the_collection), color = Chirkle.colors.muted)
                        TextButton(onClick = ::load) { Text(stringResource(R.string.room_retry)) }
                    }
                    items.isEmpty() -> Text(stringResource(R.string.room_nothing_in_this_collection_yet), color = Chirkle.colors.muted, textAlign = TextAlign.Center)
                }
            }
        }
    }
}
