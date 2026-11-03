// Room access (DESIGN.md §23.2, §23.6; web/src/views/room/access.ts): the creator (or a moderator, §36) chooses who can see the room
// (Private, Public or Open Air) and a private room's members, then who can post: everyone who can see it, or only the
// people they choose. Anyone else sees who is in it, read-only. Telegram stand-ins (no_dms, §26.3) aren't listed: the
// bridge adds them itself; they stay members and writers when it is saved.
package chirkle.android.feature.room

import androidx.compose.foundation.background
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import chirkle.android.data.api.errorMessage
import chirkle.android.data.api.reasonOf
import chirkle.android.data.lib.Limits
import chirkle.android.data.lib.canManage
import chirkle.android.data.lib.hint
import chirkle.android.data.lib.label
import chirkle.android.data.lib.postingOrDefault
import chirkle.android.data.lib.visibilityOrDefault
import chirkle.android.data.model.Posting
import chirkle.android.data.model.Room
import chirkle.android.data.model.User
import chirkle.android.data.model.Visibility
import chirkle.android.ui.Avatar
import chirkle.android.ui.Chirkle
import chirkle.android.ui.ChirkleIcons
import chirkle.android.ui.icon
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import chirkle.android.ui.LocalServices
import chirkle.android.ui.UserSearchDialog
import kotlinx.coroutines.launch

/** What a change of visibility does that may not be obvious, or "". */
fun accessWarning(from: Visibility, to: Visibility, mine: Boolean = true): String = when {
    from == to -> ""
    to == Visibility.Open -> "Everything ever written here, and everything to come, becomes readable by anyone on the web."
    from == Visibility.Private -> "Everyone with an account will be able to read the whole history."
    to == Visibility.Private ->
        "Only ${if (mine) "you and the people you add" else "its creator and the people added"} will see this room. Everyone else loses it from their list."
    else -> "People without an account won't see this room any more."
}

/** The people [ids] names, as expanded, the creator first (as the server keeps them). */
private fun users(r: Room, ids: List<String>, expanded: List<User>, me: User?): List<User> {
    val known = (r.expand?.members.orEmpty() + expanded).associateBy { it.id }.toMutableMap()
    if (me != null && me.id !in known) known[me.id] = me
    // A moderator making someone else's room private (or choosing who posts) starts with themselves (DESIGN.md §36),
    // or they would lose it.
    return (ids.ifEmpty { listOfNotNull(r.createdBy, me?.id).distinct() }).map { known[it] ?: User(it, "Unknown") }.sortedByDescending { it.id == r.createdBy }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoomAccessScreen(roomId: String, onBack: () -> Unit) {
    val services = LocalServices.current
    val s by services.store.flow.collectAsStateWithLifecycle()
    val room = s.rooms[roomId] ?: return
    val me = s.user
    val editable = room.canManage(me)
    val scope = rememberCoroutineScope()
    var visibility by remember(roomId) { mutableStateOf(room.visibilityOrDefault) }
    var posting by remember(roomId) { mutableStateOf(room.postingOrDefault) }
    var members by remember(roomId) { mutableStateOf(users(room, room.members, emptyList(), me)) }
    var writers by remember(roomId) { mutableStateOf(users(room, room.writers, room.expand?.writers.orEmpty(), me)) }
    var adding by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    // A moderator's in someone else's room (DESIGN.md §36): its creator by name, who isn't expanded unless a member.
    LaunchedEffect(roomId) {
        if (me == null || room.createdBy == me.id || room.createdBy.isEmpty()) return@LaunchedEffect
        if (members.none { it.id == room.createdBy && it.name == "Unknown" } && writers.none { it.id == room.createdBy && it.name == "Unknown" }) return@LaunchedEffect
        val creator = runCatching { services.api.usersById(listOf(room.createdBy)) }.getOrNull()?.firstOrNull() ?: return@LaunchedEffect
        members = members.map { if (it.id == creator.id) creator else it }
        writers = writers.map { if (it.id == creator.id) creator else it }
    }

    fun remove(list: String, id: String) {
        if (list == "members") {
            members = members.filter { it.id != id }
            writers = writers.filter { it.id != id } // a member taken out can't post either
        } else writers = writers.filter { it.id != id }
    }

    Scaffold(topBar = {
        TopAppBar(
            navigationIcon = { IconButton(onClick = onBack) { Icon(ChirkleIcons.Back, contentDescription = if (editable) "Cancel" else "Close") } },
            title = { Text(if (editable) "Who can see #${room.name}?" else "Members of #${room.name}") },
            actions = {
                if (editable) TextButton(enabled = !busy, onClick = {
                    busy = true
                    error = ""
                    scope.launch {
                        runCatching { services.actions.setAccess(roomId, visibility, members.map { it.id }, posting, writers.map { it.id }) }
                            .onSuccess { onBack() }
                            .onFailure { error = reasonOf(it) }
                        busy = false
                    }
                }) { Text("Save") }
            },
        )
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (editable) {
                Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (v in listOf(Visibility.Private, Visibility.Public, Visibility.Open)) {
                        Card(v == visibility, v.icon(), v.label, v.hint) {
                            visibility = v
                            error = ""
                            if (v == Visibility.Private) writers = writers.filter { w -> members.any { it.id == w.id } }
                        }
                    }
                }
            }
            // Where else the room is kept (§33.9).
            val hosts = room.shared?.with.orEmpty()
            if (hosts.isNotEmpty()) {
                Text(
                    if (room.shared?.home.orEmpty().isNotEmpty()) "This room's home is ${room.shared?.home}: who is in it is decided there."
                    else "Shared with ${hosts.joinToString(", ")}: its messages are kept there too." + if (editable) " Add people there by their address, like ann@${hosts[0]}." else "",
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.fillMaxWidth().background(Chirkle.colors.tint, MaterialTheme.shapes.medium).padding(12.dp),
                )
            }
            if (visibility == Visibility.Private) People("Members", members, room, editable, onAdd = { adding = "members" }, onRemove = { remove("members", it) })
            if (editable) {
                Text("Who can post?", style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
                Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Card(posting == Posting.Everyone, ChirkleIcons.People, "Everyone who can see it", "Guests of an Open Air room only read.") { posting = Posting.Everyone }
                    Card(posting == Posting.Selected, ChirkleIcons.Edit, "Only people you choose", "Everyone else reads and reacts, but can't post.") { posting = Posting.Selected }
                }
            }
            if (posting == Posting.Selected) People("Who can post", writers, room, editable, onAdd = { adding = "writers" }, onRemove = { remove("writers", it) })
            val warn = if (editable) accessWarning(room.visibilityOrDefault, visibility, room.createdBy == me?.id) else ""
            if (warn.isNotEmpty()) Text(warn, color = MaterialTheme.colorScheme.secondary, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive })
        }
    }

    adding?.let { which ->
        val list = if (which == "members") members else writers
        UserSearchDialog(
            title = if (which == "members") "Add members" else "Add people who post",
            onPick = { u ->
                when {
                    u.noDms && u.instance.isEmpty() -> {}
                    list.any { it.id == u.id } -> remove(which, u.id)
                    list.size >= Limits.ROOM_MEMBERS -> error = "A room can have up to ${Limits.ROOM_MEMBERS} ${if (which == "members") "members" else "people who post"}."
                    which == "members" -> members = members + u
                    visibility != Visibility.Private || members.any { it.id == u.id } -> writers = writers + u
                }
            },
            onDismiss = { adding = null },
            // The creator is always in; the others are shown checked, and a tap takes them out again.
            exclude = setOf(room.createdBy),
            selected = list.map { it.id }.toSet(),
            confirm = "Done",
            // People on the instances it is shared with, by address (§33.5).
            remote = room.shared?.with.orEmpty().isNotEmpty(),
            room = room.id,
        )
    }
}

@Composable
private fun Card(selected: Boolean, icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, hint: String, onSelect: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(if (selected) Chirkle.colors.tint else androidx.compose.ui.graphics.Color.Transparent)
            .border(if (selected) 2.dp else 1.dp, if (selected) MaterialTheme.colorScheme.primary else Chirkle.colors.border, MaterialTheme.shapes.medium)
            .selectable(selected, role = Role.RadioButton, onClick = onSelect)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected, onClick = null)
        Spacer(Modifier.width(8.dp))
        Box(Modifier.size(36.dp).background(Chirkle.colors.tint, RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column {
            Text(label, style = MaterialTheme.typography.titleSmall)
            Text(hint, style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted)
        }
    }
}

@Composable
private fun People(label: String, list: List<User>, room: Room, editable: Boolean, onAdd: () -> Unit, onRemove: (String) -> Unit) {
    // Not Telegram's stand-ins; people on linked instances are, with theirs (§33.4).
    val shown = list.filter { !it.noDms || it.instance.isNotEmpty() }
    Text("$label (${shown.size})", style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
    if (editable) TextButton(onClick = onAdd, enabled = list.size < Limits.ROOM_MEMBERS) { Text("+ Add people") }
    for (u in shown) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Avatar(u, 28.dp)
            Text(u.name, Modifier.weight(1f))
            if (u.instance.isNotEmpty()) Text(u.instance, color = Chirkle.colors.muted, style = MaterialTheme.typography.labelMedium)
            if (u.id == room.createdBy) Text("creator", color = Chirkle.colors.muted, style = MaterialTheme.typography.labelMedium)
            else if (editable) TextButton(onClick = { onRemove(u.id) }) { Text("Remove") }
        }
    }
}
