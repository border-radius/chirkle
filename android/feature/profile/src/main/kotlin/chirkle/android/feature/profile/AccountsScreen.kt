// Your accounts (ANDROID.md §17.2), opened from the brand at the top of the room list or by swiping the list left
// (§44): switch to another one, or add one on this server or another. Swiped left, it goes back to the rooms.
package chirkle.android.feature.profile

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import chirkle.android.data.lib.serverLabel
import chirkle.android.ui.Avatar
import chirkle.android.ui.Chirkle
import chirkle.android.ui.ChirkleIcons
import chirkle.android.ui.swipeAway
import chirkle.android.ui.LocalAccounts
import chirkle.android.ui.LocalServices
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountsScreen(onAddAccount: () -> Unit, onBack: () -> Unit) {
    val services = LocalServices.current
    val accounts = LocalAccounts.current
    val all = accounts?.list?.collectAsStateWithLifecycle()?.value.orEmpty().filter { it.user != null }

    Scaffold(modifier = Modifier.swipeAway(enabled = true, toRight = false, onSwipe = onBack), topBar = {
        TopAppBar(
            navigationIcon = { IconButton(onClick = onBack) { Icon(ChirkleIcons.Back, contentDescription = "Back to rooms") } },
            title = { Text("Accounts") },
        )
    }) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(Modifier.widthIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (all.isEmpty()) Text("You're not logged in to any account.", color = Chirkle.colors.muted)
                for (a in all) {
                    val user = a.user ?: continue
                    val current = a.id == services.accountId
                    Row(
                        Modifier.fillMaxWidth()
                            .heightIn(min = 56.dp)
                            .clickable(enabled = !current && accounts != null) { accounts?.scope?.launch { accounts.switchTo(a.id) } }
                            .padding(vertical = 4.dp)
                            .semantics(mergeDescendants = true) {},
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Avatar(user, 40.dp, url = a.avatarUrl)
                        Column(Modifier.weight(1f)) {
                            Text(user.name)
                            Text(serverLabel(a.server), style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted)
                        }
                        if (current) Text("In use", style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted)
                    }
                }
                if (accounts != null) OutlinedButton(onClick = onAddAccount, modifier = Modifier.padding(top = 8.dp)) { Text("Add account") }
            }
        }
    }
}
