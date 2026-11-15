// Choosing a server (ANDROID.md §17.2): for the first account, for another one, or instead of the one on screen.
package chirkle.android.feature.auth

import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import chirkle.android.data.lib.ServerProblem
import chirkle.android.ui.Chirkle
import chirkle.android.ui.LocalAccounts
import kotlinx.coroutines.launch

/** The address of a server, checked, then its Log in screen as a new account. [onCancel]: null for the first one. */
@Composable
fun ServerScreen(onCancel: (() -> Unit)?) {
    val accounts = LocalAccounts.current ?: return
    val scope = rememberCoroutineScope()
    var address by rememberSaveable { mutableStateOf("") }
    var problem by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    fun go() {
        if (busy) return
        busy = true
        problem = ""
        scope.launch {
            try {
                val server = accounts.check(address)
                // In the accounts' scope: this screen goes as the new account opens.
                accounts.scope.launch { accounts.add(server) }.join()
            } catch (e: ServerProblem) {
                problem = e.message.orEmpty()
            } finally {
                busy = false
            }
        }
    }

    Surface(Modifier.fillMaxSize()) {
        Column(
            Modifier.systemBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 420.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Spacer(Modifier.height(24.dp))
                chirkle.android.ui.BrandMark("", 64.dp)
                Text(stringResource(R.string.auth_choose_your_server), style = MaterialTheme.typography.headlineMedium)
                Text(stringResource(R.string.auth_the_address_of_the_chat), color = Chirkle.colors.muted)
                OutlinedTextField(
                    value = address,
                    onValueChange = { address = it; problem = "" },
                    label = { Text(stringResource(R.string.auth_server_address)) },
                    placeholder = { Text("chat.example.org") },
                    singleLine = true,
                    isError = problem.isNotEmpty(),
                    supportingText = if (problem.isNotEmpty()) ({ Text(problem, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }) else null,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onGo = { go() }),
                    modifier = Modifier.fillMaxWidth().semantics { if (problem.isNotEmpty()) error(problem) },
                )
                Button(onClick = ::go, enabled = !busy, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(if (busy) stringResource(R.string.auth_checking) else stringResource(R.string.auth_continue)) }
                if (onCancel != null) TextButton(onClick = onCancel, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text(stringResource(R.string.auth_cancel)) }
            }
        }
    }
}
