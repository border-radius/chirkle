// Media collections (DESIGN.md §31; web/src/views/collection/lazy.ts) as more than one screen uses them: an item's
// square tile, the save sheet (which of your collections have a file: tick to add, untick to take out, or make a new
// one), and the new-collection dialog.
package chirkle.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.collectAsState
import chirkle.android.data.api.ApiError
import chirkle.android.data.api.reasonOf
import chirkle.android.data.model.CollectionItem
import chirkle.android.data.model.SaveFrom
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * An item's square picture: its grid thumbnail, a video's poster (or a dark tile until there is one) with ▶ ([small]: a
 * smaller ▶, for a quarter of a collection's tile).
 */
@Composable
fun ItemPicture(it: CollectionItem, modifier: Modifier = Modifier, small: Boolean = false) {
    val services = LocalServices.current
    val context = LocalContext.current
    // Items' files are protected: with no token yet (the room list's tiles on a cold start), get one first (null until
    // then; a guest's is "", and public items need none).
    val token by androidx.compose.runtime.produceState(services.tokens.current.ifEmpty { null }) { value = runCatching { services.tokens.ensure() }.getOrDefault("") }
    Box(modifier.background(if (it.video) Color(0xFF13111D) else MaterialTheme.colorScheme.surfaceContainerHigh), contentAlignment = Alignment.Center) {
        val t = token
        if ((!it.video || it.poster) && t != null) {
            val url = if (it.video) services.api.itemPosterUrl(it.id, it.file, t) else services.api.itemUrl(it.id, it.file, "240x240", t)
            AsyncImage(Images.request(context, url), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
        if (it.video) {
            Box(Modifier.size(if (small) 20.dp else 32.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
                Icon(ChirkleIcons.Play, contentDescription = null, tint = Color.White, modifier = Modifier.size(if (small) 12.dp else 20.dp))
            }
        }
    }
}

/** The small round Save button over a tile (always shown: touch screens have no hover). */
@Composable
fun SaveToCollectionButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    androidx.compose.material3.IconButton(onClick = onClick, modifier = modifier.size(36.dp)) {
        Box(Modifier.size(28.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.55f)), contentAlignment = Alignment.Center) {
            Icon(ChirkleIcons.Collection, contentDescription = label, tint = Color.White, modifier = Modifier.size(16.dp))
        }
    }
}

/** Saving to a collection failed: the server's reason, or what went wrong. */
fun collectionError(e: Throwable): String = reasonOf(e)

/**
 * Save a file to your collections: each one ticked where the file is already (GET /api/chat/saved); tick to add, untick
 * to take out, or make a new (private) one there. Public ones say so: what is saved there is anyone's to see (§13).
 */
@Composable
fun SaveToCollectionSheet(from: SaveFrom, onDismiss: () -> Unit) {
    val services = LocalServices.current
    val app by services.store.flow.collectAsState()
    // On the main thread, as the services are: the sheet is another window, and its state must reach it.
    val scope = rememberCoroutineScope { services.main }
    /** Collection id → the item there (ticked). */
    val saved = remember { mutableStateMapOf<String, String>() }
    /** Collection id → ticked or unticked, while that is saving. */
    val busy = remember { mutableStateMapOf<String, Boolean>() }
    var status by remember { mutableStateOf("Loading…") }
    var name by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(from) {
        withContext(services.main) {
            services.collections.refresh()
            runCatching { services.api.savedIn(from) }
                .onSuccess { saved.clear(); saved.putAll(it); status = "" }
                .onFailure { status = collectionError(it) }
        }
    }

    suspend fun toggle(id: String, on: Boolean) {
        busy[id] = on
        status = if (on) "Saving…" else "Removing…"
        try {
            if (on) saved[id] = services.api.saveItem(id, from).id
            else saved[id]?.let { services.api.removeItem(it); saved.remove(id) }
            status = if (on) "Saved." else "Removed."
            services.collections.refresh()
        } catch (e: Exception) {
            // In there already (saved elsewhere meanwhile): it is ticked.
            if ((e as? ApiError)?.status == 409) runCatching { services.api.savedIn(from) }.onSuccess { saved.clear(); saved.putAll(it) }
            status = if ((e as? ApiError)?.status == 409) "" else collectionError(e)
        }
        busy.remove(id)
    }

    ChirkleSheet(onDismiss) {
        Row(Modifier.padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(ChirkleIcons.Collection, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Text("Save to collection", style = MaterialTheme.typography.titleMedium)
        }
        val mine = app.collections?.mine.orEmpty()
        Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
            for (c in mine) {
                val checked = busy[c.id] ?: (c.id in saved)
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 52.dp)
                        .toggleable(checked, enabled = c.id !in busy && status != "Loading…", role = Role.Checkbox) { on -> scope.launch { toggle(c.id, on) } }
                        .padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(checked, onCheckedChange = null, enabled = c.id !in busy)
                    Column(Modifier.weight(1f).padding(start = 12.dp)) {
                        Text(c.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(if (c.public) "Public: anyone can see it" else "Private", style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted)
                    }
                    // Saving copies the file on the server, which can take a while.
                    if (c.id in busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                }
            }
        }
        val text = status.ifEmpty { if (mine.isEmpty() && app.collections != null) "You have no collections yet. Make one:" else "" }
        if (text.isNotEmpty()) {
            Text(text, color = Chirkle.colors.muted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp).semantics { liveRegion = LiveRegionMode.Polite })
        }
        Row(Modifier.padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(name, { name = it }, label = { Text("New collection") }, singleLine = true, modifier = Modifier.weight(1f))
            Button(
                enabled = name.isNotBlank(),
                onClick = {
                    scope.launch {
                        try {
                            val id = services.api.createCollection(name, false)
                            name = ""
                            services.collections.reload()
                            toggle(id, true)
                        } catch (e: Exception) {
                            status = collectionError(e)
                        }
                    }
                },
            ) { Text("Create") }
        }
    }
}

/** A new collection (§31): a name, and whether anyone may see it. [onCreated] gets its id. */
@Composable
fun NewCollectionDialog(onCreated: (String) -> Unit, onDismiss: () -> Unit) {
    val services = LocalServices.current
    val scope = rememberCoroutineScope()
    var name by rememberSaveable { mutableStateOf("") }
    var public by rememberSaveable { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    fun create() {
        if (busy || name.isBlank()) return
        busy = true
        error = ""
        scope.launch {
            runCatching { services.api.createCollection(name, public) }
                .onSuccess { services.collections.refresh(); onCreated(it) }
                .onFailure { error = collectionError(it) }
            busy = false
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = { Icon(ChirkleIcons.Collection, contentDescription = null) },
        title = { Text("New collection") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    name,
                    { name = it },
                    label = { Text("Name") },
                    singleLine = true,
                    isError = error.isNotEmpty(),
                    supportingText = if (error.isNotEmpty()) ({ Text(error) }) else null,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Done),
                    keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { create() }),
                    modifier = Modifier.fillMaxWidth().focusRequester(focus),
                )
                Row(
                    Modifier.fillMaxWidth().toggleable(public, role = Role.Checkbox) { public = it }.padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(public, onCheckedChange = null)
                    Text("Public: anyone can see it and subscribe", Modifier.padding(start = 12.dp))
                }
            }
        },
        confirmButton = { Button(onClick = ::create, enabled = !busy && name.isNotBlank()) { Text("Create") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
