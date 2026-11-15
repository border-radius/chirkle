// Invite links (DESIGN.md §44; web/src/views/invite.ts and the access dialog's invite section). InviteScreen is a link's
// page, /invite/<token>: which room it is to, who made it and how many are in it; signed in, Join adds you and opens the
// room; a guest is asked to log in (and comes back here, ChirkleNav); someone in it already is offered the room. A link
// that doesn't work says so, without saying why. InviteSection is the access screen's part for those who manage a
// private room: the link made, copied, shared, made again or revoked, each at once (not on Save).
package chirkle.android.feature.room

import android.content.ClipData
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.background
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import chirkle.android.data.api.ApiError
import chirkle.android.data.api.errorMessage
import chirkle.android.data.lib.parsePb
import chirkle.android.data.model.Invite
import chirkle.android.data.model.InvitePreview
import chirkle.android.ui.Chirkle
import chirkle.android.ui.ChirkleIcons
import chirkle.android.ui.LocalServices
import kotlinx.coroutines.launch

/** How long a new link works: the server's choices (DESIGN.md §44.1). */
val INVITE_DAYS = listOf(1, 7, 30)

private fun until(expires: String): String =
    java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT).format(java.util.Date(parsePb(expires)))

private val ApiError?.gone get() = this?.status == 404

private sealed interface Page {
    data object Loading : Page
    data object Gone : Page
    data class Failed(val why: String) : Page
    data class Shown(val p: InvitePreview) : Page
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InviteScreen(token: String, onOpenRoom: (String) -> Unit, onLogIn: () -> Unit, onBack: () -> Unit) {
    val services = LocalServices.current
    val s by services.store.flow.collectAsStateWithLifecycle()
    val signedIn = s.user != null
    val scope = rememberCoroutineScope()
    var page by remember(token) { mutableStateOf<Page>(Page.Loading) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    LaunchedEffect(token, s.user?.id) {
        page = Page.Loading
        page = runCatching { services.api.invitePreview(token) }.fold(
            { Page.Shown(it) },
            { if ((it as? ApiError).gone) Page.Gone else Page.Failed(errorMessage(it)) },
        )
    }
    Scaffold(topBar = {
        TopAppBar(
            navigationIcon = { IconButton(onClick = onBack) { Icon(ChirkleIcons.Back, contentDescription = stringResource(R.string.room_back)) } },
            title = { Text(stringResource(R.string.room_invite_link)) },
        )
    }) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            when (val p = page) {
                Page.Loading -> CircularProgressIndicator()
                Page.Gone -> {
                    Text(stringResource(R.string.room_this_link_doesnt_work), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                    Text(stringResource(R.string.room_it_has_expired_or_was_revoked), color = Chirkle.colors.muted)
                }
                is Page.Failed -> Text(stringResource(R.string.room_couldnt_open_invite, p.why), color = MaterialTheme.colorScheme.error)
                is Page.Shown -> {
                    val inv = p.p
                    Text(stringResource(R.string.room_join_room, inv.room.name), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                    if (inv.member) {
                        Text(stringResource(R.string.room_youre_in_this_room_already))
                        Button(onClick = { onOpenRoom(inv.room.id) }) { Text(stringResource(R.string.room_open_the_room)) }
                        return@Column
                    }
                    val members = pluralStringResource(R.plurals.room_invite_members, inv.room.members, inv.room.members)
                    Text(
                        if (inv.by.isNotEmpty()) stringResource(R.string.room_invited_you, inv.by, members, until(inv.expires))
                        else stringResource(R.string.room_youre_invited, members, until(inv.expires)),
                        color = Chirkle.colors.muted,
                    )
                    if (!signedIn) {
                        Text(stringResource(R.string.room_log_in_to_join))
                        Button(onClick = onLogIn) { Text(stringResource(R.string.room_log_in)) }
                    } else {
                        Button(enabled = !busy, onClick = {
                            busy = true
                            error = ""
                            scope.launch {
                                runCatching { services.api.joinInvite(token) }
                                    .onSuccess { room ->
                                        // The room list has it before the room opens, so the room doesn't say it doesn't exist.
                                        runCatching { services.rooms.reload() }
                                        onOpenRoom(room)
                                    }
                                    .onFailure { e ->
                                        if ((e as? ApiError).gone) page = Page.Gone else error = errorMessage(e)
                                    }
                                busy = false
                            }
                        }) { Text(stringResource(R.string.room_join_the_room)) }
                    }
                    if (error.isNotEmpty()) {
                        Text(stringResource(R.string.room_couldnt_join, error), color = MaterialTheme.colorScheme.error, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive })
                    }
                }
            }
        }
    }
}

/** The access screen's invite link (DESIGN.md §44.1), for a room saved as private that you manage. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun InviteSection(roomId: String) {
    val services = LocalServices.current
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val res = context.resources
    val scope = rememberCoroutineScope()
    /** Not loaded yet (and "none" once loaded, null). */
    var loaded by remember(roomId) { mutableStateOf(false) }
    var invite by remember(roomId) { mutableStateOf<Invite?>(null) }
    var days by remember { mutableIntStateOf(7) }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("") }
    LaunchedEffect(roomId) {
        runCatching { services.api.invite(roomId) }
            .onSuccess { invite = it }
            .onFailure { status = res.getString(R.string.room_couldnt_load_link, errorMessage(it)) }
        loaded = true
    }
    fun url(inv: Invite) = "${services.server}/invite/${inv.token}"
    fun act(run: suspend () -> Invite?) {
        if (busy) return
        val had = invite != null
        busy = true
        status = ""
        scope.launch {
            runCatching { run() }
                .onSuccess {
                    invite = it
                    status = res.getString(
                        when {
                            it == null -> R.string.room_link_revoked
                            had -> R.string.room_new_link_ready
                            else -> R.string.room_link_ready
                        },
                    )
                }
                .onFailure { status = res.getString(R.string.room_couldnt_change_link, errorMessage(it)) }
            busy = false
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.room_invite_link), style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
        Text(stringResource(R.string.room_anyone_with_the_link_can_join), style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted)
        val inv = invite
        if (inv != null) {
            SelectionContainer {
                Text(
                    url(inv),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.fillMaxWidth().background(Chirkle.colors.tint, MaterialTheme.shapes.medium).padding(12.dp),
                )
            }
            val joined = if (inv.uses == 0) stringResource(R.string.room_nobody_joined_yet) else pluralStringResource(R.plurals.room_people_joined, inv.uses, inv.uses)
            Text(stringResource(R.string.room_works_until, until(inv.expires), joined), style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Button(onClick = {
                    scope.launch {
                        clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(res.getString(R.string.room_invite_link), url(inv))))
                        status = res.getString(R.string.room_copied)
                    }
                }) { Text(stringResource(R.string.room_copy_link)) }
                OutlinedButton(onClick = {
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url(inv))
                    runCatching { context.startActivity(Intent.createChooser(send, null)) }
                }) { Text(stringResource(R.string.room_share_link)) }
            }
        }
        Text(stringResource(R.string.room_works_for), style = MaterialTheme.typography.labelLarge)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (d in INVITE_DAYS) {
                FilterChip(selected = days == d, onClick = { days = d }, label = { Text(pluralStringResource(R.plurals.room_days, d, d)) })
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (inv == null) {
                Button(enabled = loaded && !busy, onClick = { act { services.api.makeInvite(roomId, days) } }) { Text(stringResource(R.string.room_create_link)) }
            } else {
                OutlinedButton(enabled = !busy, onClick = { act { services.api.makeInvite(roomId, days) } }) { Text(stringResource(R.string.room_new_link)) }
                TextButton(enabled = !busy, onClick = { act { services.api.revokeInvite(roomId); null } }) { Text(stringResource(R.string.room_revoke)) }
            }
        }
        if (status.isNotEmpty()) {
            Text(status, style = MaterialTheme.typography.bodySmall, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        }
    }
}
