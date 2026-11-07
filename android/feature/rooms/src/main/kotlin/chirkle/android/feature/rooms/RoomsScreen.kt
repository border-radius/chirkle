// The room list (DESIGN.md §5, §16.5, §18.4; web/src/views/rooms.ts): DMs, rooms, your media collections and those you
// follow (§31.3), and the hidden and archived rooms folded away; unread badges, unread rows first; a row's menu (hide,
// close, archive). A section's heading folds it, as on the web: then only its unread rows stay listed. A guest sees the
// Open Air rooms (§23.3). The brand at the top, or a swipe to the right, opens your accounts (ANDROID.md §17.2, §44). The look (2026-10-31 redesign): a
// search pill on top (brand, Jump to, your avatar), Rooms, Direct messages and Collections each with its "+", then one
// folded Hidden & archived section, on the sidebar's darker surface.
package chirkle.android.feature.rooms

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.ui.draw.clip
import chirkle.android.ui.icon
import chirkle.android.ui.swipeAway
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.unit.sp
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import chirkle.android.data.api.ApiError
import chirkle.android.data.api.errorMessage
import chirkle.android.data.lib.Limits
import chirkle.android.data.lib.canManage
import chirkle.android.data.lib.hint
import chirkle.android.data.lib.label
import chirkle.android.data.lib.otherMember
import chirkle.android.data.lib.roomSections
import chirkle.android.data.lib.textLength
import chirkle.android.data.lib.title
import chirkle.android.data.lib.unreadBadge
import chirkle.android.data.lib.visibilityOrDefault
import chirkle.android.data.model.Room
import chirkle.android.data.model.Visibility
import chirkle.android.data.repo.AppState
import chirkle.android.data.repo.LoadStatus
import chirkle.android.ui.Avatar
import chirkle.android.ui.Chirkle
import chirkle.android.ui.ChirkleIcons
import chirkle.android.ui.LocalServices
import chirkle.android.ui.UserSearchDialog
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import chirkle.android.data.lib.jumpMatches
import chirkle.android.data.lib.jumpTargets

private enum class Section { Rooms, Dms, Hidden, Archived }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoomsScreen(onOpenRoom: (String) -> Unit, onProfile: () -> Unit, onLogIn: () -> Unit, onOpenCollection: (String) -> Unit = {}, onAccounts: () -> Unit = {}) {
    val services = LocalServices.current
    val s by services.store.flow.collectAsStateWithLifecycle()
    val me = s.user
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var newRoom by rememberSaveable { mutableStateOf(false) }
    var newDm by rememberSaveable { mutableStateOf(false) }
    var newCollection by rememberSaveable { mutableStateOf(false) }
    var archiving by remember { mutableStateOf<Room?>(null) }
    val sections = remember(s.rooms, s.hidden, me, s.activeRoomId, s.unread) { roomSections(s.rooms.values, s.hidden.keys, me?.id, s.activeRoomId, s.unread) }
    val folded by services.settings.folded.collectAsStateWithLifecycle()

    fun act(label: String, room: Room, block: suspend () -> Unit) {
        scope.launch {
            runCatching { block() }.onFailure { e ->
                snackbar.showSnackbar("Couldn't $label “${if (room.isDm) room.title(me?.id) else room.name}”. ${errorMessage(e)}")
            }
        }
    }

    var jumping by rememberSaveable { mutableStateOf(false) }
    var jumpQuery by rememberSaveable { mutableStateOf("") }
    fun closeJump() { jumping = false; jumpQuery = "" }
    fun open(t: chirkle.android.data.lib.JumpTarget) = if (t.room != null) onOpenRoom(t.id) else onOpenCollection(t.id)
    androidx.activity.compose.BackHandler(enabled = jumping, onBack = ::closeJump)

    Scaffold(
        // Ctrl+K or Ctrl+P from a hardware keyboard: Jump to (§32), as on the web.
        modifier = Modifier.onPreviewKeyEvent { e ->
            if (e.type == KeyEventType.KeyDown && e.isCtrlPressed && !e.isAltPressed && !e.isShiftPressed && (e.key == Key.K || e.key == Key.P)) {
                // Held down, the key repeats: only the first press toggles (the web's QA BUG-137; BUG-159).
                if (e.nativeKeyEvent.repeatCount == 0) { if (jumping) closeJump() else jumping = true }
                true
            } else false
        }
            // Dragged to the right, the list opens your accounts, as the brand does (§44, §52).
            .swipeAway(enabled = !jumping, toRight = true, onSwipe = onAccounts),
        topBar = {
            if (jumping) {
                val focus = remember { FocusRequester() }
                LaunchedEffect(Unit) { focus.requestFocus() }
                TopAppBar(
                    navigationIcon = { IconButton(onClick = ::closeJump) { Icon(ChirkleIcons.Back, contentDescription = "Close search") } },
                    title = {
                        androidx.compose.material3.TextField(
                            jumpQuery,
                            { jumpQuery = it },
                            placeholder = { Text("Jump to a room or person", maxLines = 1) },
                            singleLine = true,
                            colors = androidx.compose.material3.TextFieldDefaults.colors(
                                focusedContainerColor = androidx.compose.ui.graphics.Color.Transparent,
                                unfocusedContainerColor = androidx.compose.ui.graphics.Color.Transparent,
                                focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                                unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                            ),
                            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Go),
                            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onGo = {
                                jumpMatches(jumpTargets(sections, me?.id, s.collections, services.opened::get), jumpQuery).firstOrNull()?.let { closeJump(); open(it) }
                            }),
                            modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = "Jump to" },
                        )
                    },
                    actions = {
                        if (jumpQuery.isNotEmpty()) IconButton(onClick = { jumpQuery = "" }) { Icon(ChirkleIcons.Close, contentDescription = "Clear") }
                    },
                )
                return@Scaffold
            }
            // A search pill: the brand (your accounts), Jump to, and you (or Log in). On the list's own background, from the
            // top of the screen: rows scrolled up go under it, not into the status bar or around the pill (QA BUG-209).
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .statusBarsPadding()
                    .padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 8.dp)
                    .heightIn(min = 56.dp)
                    .background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(28.dp))
                    .padding(start = 4.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier.size(48.dp).clip(CircleShape).clickable(onClickLabel = "Accounts", onClick = onAccounts).semantics(mergeDescendants = true) {
                        contentDescription = s.site.title
                    },
                    contentAlignment = Alignment.Center,
                ) { chirkle.android.ui.BrandMark(s.site.logo, 26.dp) }
                Column(
                    Modifier
                        .weight(1f)
                        .heightIn(min = 48.dp)
                        .clip(RoundedCornerShape(24.dp))
                        .clickable { jumping = true }
                        .semantics(mergeDescendants = true) { contentDescription = "Jump to a room or person" }
                        .padding(horizontal = 6.dp),
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text("Jump to…", color = Chirkle.colors.muted, maxLines = 1)
                    // Which account this is, once there are several (ANDROID.md §17.2).
                    val many = (chirkle.android.ui.LocalAccounts.current?.list?.collectAsStateWithLifecycle()?.value?.count { it.user != null } ?: 0) > 1
                    if (many) Text(chirkle.android.data.lib.serverLabel(services.server), style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.dim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (me != null) {
                    IconButton(onClick = onProfile, modifier = Modifier.size(48.dp).semantics { contentDescription = "Profile" }) { Avatar(me, 32.dp) }
                } else {
                    TextButton(onClick = onLogIn) { Text("Log in") }
                }
            }
        },
        containerColor = if (jumping) MaterialTheme.colorScheme.surface else MaterialTheme.colorScheme.surfaceVariant,
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        if (jumping) {
            val found = remember(sections, s.collections, jumpQuery, me) { jumpMatches(jumpTargets(sections, me?.id, s.collections, services.opened::get), jumpQuery) }
            LazyColumn(Modifier.fillMaxSize().semantics { contentDescription = "Rooms" }, contentPadding = padding) {
                if (found.isEmpty()) empty("Nothing found.")
                items(found, key = { "j" + it.id }) { t ->
                    JumpRow(t, s, me?.id) { closeJump(); open(t) }
                }
            }
            return@Scaffold
        }
        var showMore by rememberSaveable { mutableStateOf(false) }
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding() + 24.dp),
        ) {
            // The first load: a spinner, not an empty list that fills in.
            if (s.rooms.isEmpty() && (s.roomsStatus == LoadStatus.Loading || s.roomsStatus == LoadStatus.Idle)) {
                item(key = "loading") {
                    Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                        androidx.compose.material3.CircularProgressIndicator(Modifier.size(32.dp).semantics { contentDescription = "Loading rooms" })
                    }
                }
                return@LazyColumn
            }
            if (s.roomsStatus == LoadStatus.Error && s.rooms.isEmpty()) {
                item {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("Couldn't load rooms. Check your connection. ", Modifier.weight(1f))
                        TextButton(onClick = { scope.launch { services.rooms.reload() } }) { Text("Retry") }
                    }
                }
            }
            if (me == null) {
                header("Open Air rooms")
                if (sections.rooms.isEmpty() && s.roomsStatus == LoadStatus.Ready) empty("No Open Air rooms yet. Log in to see the others.")
                items(sections.rooms, key = { it.id }) { r -> RoomRow(r, s, me?.id, onOpenRoom, emptyList()) }
                return@LazyColumn
            }
            // A folded section lists only its unread rows (the open room has no badge: it is never listed folded).
            fun shown(section: String, list: List<Room>) =
                if (section in folded) list.filter { unreadBadge(it, s.unread, s.hidden.keys) > 0 } else list
            val toggle = services.settings::toggleFolded
            foldHeader("rooms", "Rooms", "rooms" in folded, toggle, "New room") { newRoom = true }
            if (sections.rooms.isEmpty() && s.roomsStatus == LoadStatus.Ready) {
                empty(if (sections.hidden.isNotEmpty() || sections.archived.isNotEmpty()) "No other rooms. Hidden and archived ones are listed below." else "No rooms yet. Create the first one.")
            }
            items(shown("rooms", sections.rooms), key = { it.id }) { r -> RoomRow(r, s, me.id, onOpenRoom, menuItems(r, Section.Rooms, s, ::act, { archiving = it }, services), button = false) }
            foldHeader("dms", "Direct messages", "dms" in folded, toggle, "New direct message") { newDm = true }
            items(shown("dms", sections.dms), key = { it.id }) { r ->
                RoomRow(r, s, me.id, onOpenRoom, listOf("Close conversation" to { act("close", r) { services.actions.hide(r.id) } }), button = false)
            }
            collections(s.collections, "collections" in folded, { toggle("collections") }, onOpenCollection) { newCollection = true }
            // Hidden & archived (§7.1): one fold with how many; inside, a part for each.
            val moreCount = sections.hidden.size + sections.archived.size
            if (moreCount > 0) {
                fold("Hidden & archived", moreCount, showMore) { showMore = !showMore }
                if (showMore) {
                    if (sections.hidden.isNotEmpty()) part("Hidden", ChirkleIcons.Hide)
                    items(sections.hidden, key = { "h" + it.id }) { r -> RoomRow(r, s, me.id, onOpenRoom, menuItems(r, Section.Hidden, s, ::act, { archiving = it }, services)) }
                    if (sections.archived.isNotEmpty()) part("Archived", ChirkleIcons.Archive)
                    items(sections.archived, key = { "a" + it.id }) { r -> RoomRow(r, s, me.id, onOpenRoom, menuItems(r, Section.Archived, s, ::act, { archiving = it }, services)) }
                }
            }
        }
    }

    archiving?.let { r ->
        AlertDialog(
            onDismissRequest = { archiving = null },
            title = { Text("Archive room") },
            text = { Text("Archive “${r.name}”? It becomes read-only for everyone.") },
            confirmButton = { TextButton(onClick = { archiving = null; act("archive", r) { services.actions.setArchived(r.id, true) } }) { Text("Archive") } },
            dismissButton = { TextButton(onClick = { archiving = null }) { Text("Cancel") } },
        )
    }
    if (newCollection) chirkle.android.ui.NewCollectionDialog(onCreated = { newCollection = false; onOpenCollection(it) }, onDismiss = { newCollection = false })
    if (newRoom) NewRoomDialog(onCreated = { newRoom = false; onOpenRoom(it.id) }, onDismiss = { newRoom = false })
    if (newDm) {
        UserSearchDialog(
            title = "New message",
            onPick = { u ->
                newDm = false
                scope.launch {
                    runCatching { services.actions.openDm(u.id) }
                        .onSuccess { onOpenRoom(it.id) }
                        .onFailure { e -> snackbar.showSnackbar("Couldn't open the conversation with “${u.name}”. ${errorMessage(e)}") }
                }
            },
            onDismiss = { newDm = false },
            exclude = setOfNotNull(me?.id),
        )
    }
}

private fun menuItems(
    r: Room,
    section: Section,
    s: AppState,
    act: (String, Room, suspend () -> Unit) -> Unit,
    archive: (Room) -> Unit,
    services: chirkle.android.data.repo.ChirkleServices,
): List<Pair<String, () -> Unit>> {
    // Its creator's, or a moderator's (DESIGN.md §36).
    val mine = r.canManage(s.user)
    val items = mutableListOf<Pair<String, () -> Unit>>()
    if (section == Section.Rooms) items += "Hide" to { act("hide", r) { services.actions.hide(r.id) } }
    // An archived room you had hidden is listed under Archived; it can still be unhidden from there.
    if (section == Section.Hidden || (section == Section.Archived && r.id in s.hidden)) items += "Unhide" to { act("unhide", r) { services.actions.unhide(r.id) } }
    if (mine && section != Section.Archived) items += "Archive" to { archive(r) }
    if (mine && section == Section.Archived) items += "Unarchive" to { act("unarchive", r) { services.actions.setArchived(r.id, false) } }
    return items
}

@Composable
private fun JumpRow(t: chirkle.android.data.lib.JumpTarget, s: AppState, me: String?, onOpen: () -> Unit) {
    val badge = t.room?.let { unreadBadge(it, s.unread, s.hidden.keys) } ?: t.collection?.takeIf { it.owner != null }?.new ?: 0
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(onClick = onOpen).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        val room = t.room
        if (room != null) chirkle.android.ui.RoomPicture(room, me)
        else Box(Modifier.size(40.dp).background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
            Icon(ChirkleIcons.Collection, contentDescription = null, tint = Chirkle.colors.dim, modifier = Modifier.size(18.dp))
        }
        Text(t.name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = if (badge > 0) FontWeight.Bold else FontWeight.Normal)
        if (t.note.isNotEmpty()) Text(t.note, style = MaterialTheme.typography.labelMedium, color = Chirkle.colors.muted)
        if (badge > 0) UnreadBadge(badge)
    }
}

@Composable
private fun UnreadBadge(badge: Int) {
    Box(
        Modifier.heightIn(min = 24.dp).widthIn(min = 24.dp).background(Chirkle.colors.fill, CircleShape).padding(horizontal = 8.dp, vertical = 2.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            if (badge > 99) "99+" else badge.toString(),
            color = androidx.compose.ui.graphics.Color.White,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.semantics { contentDescription = "$badge unread" },
        )
    }
}

private fun LazyListScope.header(text: String) = item(key = "header-$text") {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = Chirkle.colors.muted,
        modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp).semantics { heading() },
    )
}

/**
 * Yours (🔒 when private), then those you follow with their owner's name and how many items are new (§31.3), three to a
 * row as tinted tiles (the redesign's AndroidRooms board). Folded: only those you follow with new items.
 */
private fun LazyListScope.collections(c: chirkle.android.data.model.Collections?, folded: Boolean, toggle: () -> Unit, onOpen: (String) -> Unit, onNew: () -> Unit) {
    item(key = "header-collections") {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            FoldTitle("Collections", folded, toggle, Modifier.weight(1f))
            IconButton(onClick = onNew, modifier = Modifier.size(48.dp)) { Icon(ChirkleIcons.Add, contentDescription = "New collection", tint = Chirkle.colors.muted) }
        }
    }
    if (c == null) return
    if (c.mine.isEmpty() && c.subs.isEmpty()) empty("No collections yet. Save images and videos from the chat to one.")
    val shown = (if (folded) emptyList() else c.mine) + (if (folded) c.subs.filter { it.new > 0 } else c.subs)
    items(shown.chunked(3), key = { row -> "c" + row.first().id }) { row ->
        Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 4.dp, bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            row.forEach { CollectionTile(it, onOpen, Modifier.weight(1f)) }
            repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
        }
    }
}

/** A section's heading that folds it (the web's fold buttons), and its "+". */
private fun LazyListScope.foldHeader(section: String, text: String, folded: Boolean, toggle: (String) -> Unit, add: String, onAdd: () -> Unit) = item(key = "header-$section") {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        FoldTitle(text, folded, { toggle(section) }, Modifier.weight(1f))
        IconButton(onClick = onAdd, modifier = Modifier.size(48.dp)) { Icon(ChirkleIcons.Add, contentDescription = add, tint = Chirkle.colors.muted) }
    }
}

/** A part of Hidden & archived: its icon and name, small. */
private fun LazyListScope.part(text: String, icon: androidx.compose.ui.graphics.vector.ImageVector) = item(key = "part-$text") {
    Row(
        Modifier.padding(start = 12.dp, top = 8.dp, bottom = 4.dp).semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(icon, contentDescription = null, tint = Chirkle.colors.dim, modifier = Modifier.size(16.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, color = Chirkle.colors.dim)
    }
}

@Composable
private fun FoldTitle(text: String, folded: Boolean, toggle: () -> Unit, modifier: Modifier) {
    Row(
        modifier
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(24.dp))
            .clickable(onClickLabel = if (folded) "Expand" else "Collapse", onClick = toggle)
            .padding(start = 12.dp, end = 12.dp)
            .semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(
            ChirkleIcons.Down,
            contentDescription = if (folded) "folded" else null,
            tint = Chirkle.colors.muted,
            modifier = Modifier.size(18.dp).rotate(if (folded) -90f else 0f),
        )
        Text(text, style = MaterialTheme.typography.titleSmall, color = Chirkle.colors.muted)
    }
}

/** The web's tints for a collection's tile (web/styles/app/collections.css .t0–.t3), picked the same way, by its id. */
private val Hues = listOf(Color(0xFFA78BFA), Color(0xFF38BDF8), Color(0xFFFB923C), Color(0xFF4ADE80))

@Composable
private fun CollectionTile(c: chirkle.android.data.model.MediaCollection, onOpen: (String) -> Unit, modifier: Modifier) {
    val hue = Hues[c.id.first().code % Hues.size]
    Column(
        modifier
            .clip(RoundedCornerShape(14.dp))
            .clickable { onOpen(c.id) }
            .semantics(mergeDescendants = true) {},
    ) {
        val tint = hue.copy(alpha = 0.16f).compositeOver(MaterialTheme.colorScheme.background)
        val locked = c.owner == null && !c.public
        Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(14.dp)).background(tint)) {
            Preview(c.preview, tint)
            // An empty one's lock in its corner; over pictures it covered the last quarter's play badge (QA BUG-248),
            // so then it follows the name.
            if (locked && c.preview.isEmpty()) {
                Icon(ChirkleIcons.Lock, contentDescription = "private", tint = Chirkle.colors.muted, modifier = Modifier.align(Alignment.BottomEnd).padding(10.dp).size(14.dp))
            }
            if (c.new > 0) {
                Box(
                    Modifier.align(Alignment.TopEnd).padding(8.dp).heightIn(min = 22.dp).widthIn(min = 22.dp).background(Chirkle.colors.fill, CircleShape).padding(horizontal = 7.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        if (c.new > 99) "99+" else c.new.toString(),
                        color = Color.White,
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.semantics { contentDescription = "${c.new} new" },
                    )
                }
            }
        }
        Spacer(Modifier.size(6.dp))
        Row(Modifier.padding(horizontal = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                c.name,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                fontSize = 13.sp,
                lineHeight = 16.sp,
                fontWeight = if (c.new > 0) FontWeight.Bold else FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (locked && c.preview.isNotEmpty()) Icon(ChirkleIcons.Lock, contentDescription = "private", tint = Chirkle.colors.muted, modifier = Modifier.size(12.dp))
        }
        Text(
            c.owner?.name ?: if (c.items == 1) "1 item" else "${c.items} items",
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            fontSize = 11.sp,
            lineHeight = 14.sp,
            color = Chirkle.colors.muted,
            modifier = Modifier.padding(start = 2.dp, end = 2.dp, bottom = 2.dp),
        )
    }
}

/**
 * A collection's newest items on its tile, so what is in it shows without opening it: one fills the tile; two to four
 * share it as quarters, newest first (top left), the rest of the quarters left [tint].
 */
@Composable
private fun Preview(items: List<chirkle.android.data.model.CollectionItem>, tint: Color) {
    when (items.size) {
        0 -> Unit
        1 -> chirkle.android.ui.ItemPicture(items[0], Modifier.fillMaxSize())
        else -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            for (row in 0..1) {
                Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    for (col in 0..1) {
                        val it = items.getOrNull(row * 2 + col)
                        if (it != null) chirkle.android.ui.ItemPicture(it, Modifier.weight(1f).fillMaxSize(), small = true)
                        else Box(Modifier.weight(1f).fillMaxSize().background(tint))
                    }
                }
            }
        }
    }
}

private fun LazyListScope.empty(text: String) = item(key = "empty-$text") {
    Text(text, color = Chirkle.colors.muted, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
}

/** Hidden & archived's heading: a chevron, the name, and how many on the right. */
private fun LazyListScope.fold(text: String, count: Int, open: Boolean, toggle: () -> Unit) = item(key = "fold-$text") {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(24.dp))
            .clickable(onClickLabel = if (open) "Collapse" else "Expand", onClick = toggle)
            .padding(horizontal = 12.dp)
            .semantics(mergeDescendants = true) { heading(); contentDescription = "$text ($count)" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(ChirkleIcons.Down, contentDescription = null, tint = Chirkle.colors.muted, modifier = Modifier.size(18.dp).rotate(if (open) 0f else -90f))
        Text(text, style = MaterialTheme.typography.titleSmall, color = Chirkle.colors.muted, modifier = Modifier.weight(1f))
        Text(count.toString(), style = MaterialTheme.typography.titleSmall, color = Chirkle.colors.muted, modifier = Modifier.padding(end = 4.dp))
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
/**
 * [button]: the menu has a ⋮ of its own. Rows in Rooms and Direct messages have none (the web's QA BUG-196, the
 * AndroidRooms board): a long press opens their menu; hidden and archived rows keep theirs.
 */
private fun RoomRow(r: Room, s: AppState, me: String?, onOpen: (String) -> Unit, menu: List<Pair<String, () -> Unit>>, button: Boolean = true) {
    var open by remember { mutableStateOf(false) }
    val badge = unreadBadge(r, s.unread, s.hidden.keys)
    val title = r.title(me)
    val current = s.activeRoomId == r.id
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(if (current) Chirkle.colors.tint else androidx.compose.ui.graphics.Color.Transparent)
                .combinedClickable(onClick = { onOpen(r.id) }, onLongClick = if (menu.isNotEmpty()) ({ open = true }) else null, onLongClickLabel = "Actions for $title")
                .padding(start = 12.dp, end = if (menu.isNotEmpty() && button) 0.dp else 12.dp)
                .semantics(mergeDescendants = true) {},
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (r.isDm) {
                r.otherMember(me)?.let { Avatar(it, 40.dp) }
            } else {
                chirkle.android.ui.RoomIcon(Visibility.Public, 40.dp)
            }
            Text(
                if (r.isDm) title else r.name,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                fontWeight = if (badge > 0 || current) FontWeight.SemiBold else FontWeight.Medium,
                color = if (r.archived) Chirkle.colors.dim else if (badge > 0 || current) MaterialTheme.colorScheme.onSurface else Chirkle.colors.muted,
            )
            // Private and Open Air (§23.1), at the end of the row, before the count (the AndroidRooms board).
            val v = r.visibilityOrDefault
            if (!r.isDm && v != Visibility.Public) {
                Icon(v.icon(), contentDescription = v.label, tint = Chirkle.colors.dim, modifier = Modifier.size(15.dp))
            }
            if (badge > 0) UnreadBadge(badge)
            if (menu.isNotEmpty()) {
                // The menu opens at the button (a long press on the row opens it there too).
                Box {
                    if (button) {
                        IconButton(onClick = { open = true }, modifier = Modifier.semantics { contentDescription = "Actions for $title" }) {
                            Icon(ChirkleIcons.More, contentDescription = null, tint = Chirkle.colors.muted)
                        }
                    }
                    DropdownMenu(open, onDismissRequest = { open = false }) {
                        for ((label, run) in menu) {
                            DropdownMenuItem(text = { Text(label) }, leadingIcon = { Icon(menuIcon(label), contentDescription = null) }, onClick = { open = false; run() })
                        }
                    }
                }
            }
        }
    }
}

private fun menuIcon(label: String) = when (label) {
    "Unhide" -> ChirkleIcons.Show
    "Archive", "Unarchive" -> ChirkleIcons.Archive
    else -> ChirkleIcons.Hide
}

@Composable
private fun NewRoomDialog(onCreated: (Room) -> Unit, onDismiss: () -> Unit) {
    val services = LocalServices.current
    val scope = rememberCoroutineScope()
    var name by rememberSaveable { mutableStateOf("") }
    var visibility by rememberSaveable { mutableStateOf(Visibility.Public) }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val nameFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { nameFocus.requestFocus() } }
    fun create() {
        if (busy) return
        if (textLength(name.trim()) > Limits.ROOM_NAME) {
            error = "Must be no more than ${Limits.ROOM_NAME} characters."
            return
        }
        busy = true
        error = ""
        scope.launch {
            runCatching { services.actions.create(name, visibility) }
                .onSuccess(onCreated)
                .onFailure { e -> error = if (e is ApiError && e.codes["name"] == "validation_not_unique") "A room with this name already exists." else (e as? ApiError)?.fields?.get("name") ?: errorMessage(e) }
            busy = false
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New room") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    name,
                    { name = it },
                    label = { Text("Room name") },
                    placeholder = { Text("room-name") },
                    singleLine = true,
                    isError = error.isNotEmpty(),
                    supportingText = if (error.isNotEmpty()) ({ Text(error) }) else null,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Done),
                    keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { if (name.isNotBlank()) create() }),
                    modifier = Modifier.fillMaxWidth().focusRequester(nameFocus),
                )
                Text("Who can see it", style = MaterialTheme.typography.titleSmall)
                for (v in listOf(Visibility.Public, Visibility.Private, Visibility.Open)) {
                    Row(
                        Modifier.fillMaxWidth().selectable(visibility == v, role = Role.RadioButton) { visibility = v }.padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(visibility == v, onClick = null)
                        Spacer(Modifier.width(8.dp))
                        Column {
                            Text(v.label)
                            Text(v.hint, style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted)
                        }
                    }
                }
            }
        },
        confirmButton = { Button(onClick = ::create, enabled = !busy && name.isNotBlank()) { Text("Create") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
