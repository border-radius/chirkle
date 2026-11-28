// Finding people by name (§16.3, web/src/ui/user-search.ts): for a new DM, and for a room's members and writers. An
// address, "ann@b.example", finds someone on a linked instance (§33.5).
package chirkle.android.ui

import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.unit.dp
import chirkle.android.data.api.reasonOf
import chirkle.android.data.lib.isAddress
import chirkle.android.data.lib.matchRange
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import chirkle.android.data.model.User
import kotlinx.coroutines.delay

/**
 * A dialog that finds people by name; [onPick] gets the one chosen. [exclude]: ids not to offer; [selected]: ids shown
 * checked. [remote]: an address is looked up on its instance; [room], to add them to that shared room (else for a DM).
 */
/** [text] with where [query] first matches it (ignoring case) in bold. */
internal fun marked(text: String, query: String): AnnotatedString {
    val r = matchRange(text, query) ?: return AnnotatedString(text)
    return buildAnnotatedString {
        append(text.substring(0, r.first))
        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(text.substring(r.first, r.last + 1)) }
        append(text.substring(r.last + 1))
    }
}

@Composable
fun UserSearchDialog(
    title: String,
    onPick: (User) -> Unit,
    onDismiss: () -> Unit,
    exclude: Set<String> = emptySet(),
    confirm: String? = null,
    selected: Set<String> = emptySet(),
    remote: Boolean = true,
    room: String? = null,
) {
    val res = LocalContext.current.resources
    val services = LocalServices.current
    var query by remember { mutableStateOf("") }
    var found by remember { mutableStateOf<List<User>?>(null) }
    // The query [found] answers: Done picks only from the current query's results.
    var foundFor by remember { mutableStateOf("") }
    var status by remember { mutableStateOf(res.getString(R.string.ui_type_a_name)) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    LaunchedEffect(query) {
        if (query.isBlank()) {
            found = null
            status = res.getString(R.string.ui_type_a_name)
            return@LaunchedEffect
        }
        delay(250)
        status = res.getString(R.string.ui_searching)
        val q = query.trim()
        var refused = ""
        found = runCatching { if (remote && isAddress(q)) listOf(services.api.remoteUser(q, room)) else services.api.searchUsers(q) }
            .onFailure { if (remote && isAddress(q)) refused = reasonOf(it) }
            .getOrNull()?.filter { it.id !in exclude }
        foundFor = q
        status = when {
            refused.isNotEmpty() -> refused
            found == null -> res.getString(R.string.ui_couldnt_search_check_your_connection)
            found!!.isEmpty() -> res.getString(R.string.ui_no_one_found_for, q)
            else -> ""
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    query,
                    { query = it },
                    placeholder = { Text(stringResource(R.string.ui_find_someone)) },
                    singleLine = true,
                    // Done picks the first found, as the forward sheet and Jump to do (QA BUG-272).
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Done),
                    keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = {
                        if (foundFor == query.trim()) found.orEmpty().firstOrNull { !it.noDms || confirm != null }?.let(onPick)
                    }),
                    modifier = Modifier.fillMaxWidth().focusRequester(focus),
                )
                if (status.isNotEmpty()) {
                    val none = found?.isEmpty() == true && foundFor.isNotEmpty() && status == res.getString(R.string.ui_no_one_found_for, foundFor)
                    Column(Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }) {
                        Text(status, color = if (none) MaterialTheme.colorScheme.onSurface else Chirkle.colors.muted, style = MaterialTheme.typography.bodyMedium, fontWeight = if (none) FontWeight.SemiBold else null)
                        // Nothing found: a tip, as the web's New message card gives (2026-11-24).
                        if (none) Text(stringResource(R.string.ui_check_the_spelling), color = Chirkle.colors.muted, style = MaterialTheme.typography.bodySmall)
                    }
                }
                LazyColumn(Modifier.heightIn(max = 320.dp)) {
                    items(found.orEmpty(), key = { it.id }) { u ->
                        Row(
                            Modifier.fillMaxWidth().clickable(enabled = !u.noDms || confirm != null) { onPick(u) }.padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Avatar(u, 32.dp)
                            Column(Modifier.weight(1f)) {
                                // The letters that matched in bold, and the @handle under the name (the web's card, 2026-11-24).
                                Text(marked(u.name, foundFor))
                                val on = if (u.instance.isNotEmpty()) stringResource(R.string.ui_on, u.instance) else ""
                                val sub = listOf(if (u.handle.isNotEmpty()) "@${u.handle}" else "", on).filter { it.isNotEmpty() }.joinToString(" · ")
                                if (sub.isNotEmpty()) Text(if (u.handle.isNotEmpty()) marked(sub, "@" + foundFor.removePrefix("@")) else AnnotatedString(sub), style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted)
                                if (u.noDms && confirm == null) Text(stringResource(R.string.ui_doesnt_take_direct_messages), style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted)
                            }
                            if (u.id in selected) Icon(ChirkleIcons.Check, contentDescription = stringResource(R.string.ui_added), tint = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(confirm ?: stringResource(R.string.ui_cancel)) } },
    )
}
