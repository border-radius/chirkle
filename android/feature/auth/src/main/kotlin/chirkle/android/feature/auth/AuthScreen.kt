package chirkle.android.feature.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.text.style.TextOverflow
import chirkle.android.data.lib.serverLabel
import chirkle.android.ui.Avatar
import chirkle.android.ui.Chirkle
import chirkle.android.ui.LocalAccounts
import chirkle.android.ui.LocalServices
import kotlinx.coroutines.launch
import coil3.compose.AsyncImage

/**
 * Log in or sign up (§7.1) on the account's server, which [onChangeServer] changes (ANDROID.md §17.2). [onGuest]: read
 * the Open Air rooms without an account (§23.3). Your other accounts are a tap away. "Forgot password?" (§39) while the
 * server sends email: asks where to send a reset link.
 */
@Composable
fun AuthScreen(initial: AuthMode, onChangeServer: () -> Unit, onGuest: () -> Unit) {
    val services = LocalServices.current
    val accounts = LocalAccounts.current
    val others = accounts?.list?.collectAsStateWithLifecycle()?.value.orEmpty().filter { it.user != null && it.id != services.accountId }
    // The view model's messages, from this module's strings.xml (the application's resources: nothing of the activity kept).
    val res = LocalContext.current.applicationContext.resources
    val text: (Int, Array<out Any>) -> String = { id, args -> res.getString(id, *args) }
    val vm: AuthViewModel = viewModel(key = "auth") { AuthViewModel(services, initial, text) }
    val state by services.store.flow.collectAsStateWithLifecycle()
    val site = state.site
    Surface(Modifier.fillMaxSize()) {
        Column(
            Modifier.systemBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 420.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Spacer(Modifier.height(24.dp))
                chirkle.android.ui.BrandMark(site.logo, 64.dp)
                Text(site.title, style = MaterialTheme.typography.headlineMedium)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.auth_on_server, serverLabel(services.server)), color = Chirkle.colors.muted, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    TextButton(onClick = onChangeServer, enabled = !vm.busy) { Text(stringResource(R.string.auth_change_server)) }
                }
                if (vm.mode == AuthMode.Forgot) {
                    ForgotPassword(vm)
                } else {
                    PrimaryTabRow(selectedTabIndex = vm.mode.ordinal) {
                        Tab(vm.mode == AuthMode.LogIn, onClick = { vm.switch(AuthMode.LogIn) }, text = { Text(stringResource(R.string.auth_log_in)) })
                        Tab(vm.mode == AuthMode.SignUp, onClick = { vm.switch(AuthMode.SignUp) }, text = { Text(stringResource(R.string.auth_sign_up)) })
                    }
                    val err = vm.fieldErrors
                    if (vm.mode == AuthMode.SignUp) {
                        Field(stringResource(R.string.auth_display_name), vm.name, { vm.name = it }, err["name"], ContentType.PersonFullName)
                    }
                    Field(stringResource(R.string.auth_email), vm.email, { vm.email = it }, err["email"], ContentType.EmailAddress, KeyboardType.Email)
                    Field(
                        stringResource(R.string.auth_password),
                        vm.password,
                        { vm.password = it },
                        err["password"],
                        if (vm.mode == AuthMode.LogIn) ContentType.Password else ContentType.NewPassword,
                        KeyboardType.Password,
                        password = true,
                        last = vm.mode == AuthMode.LogIn || !state.site.inviteOnly,
                        onDone = vm::submit,
                    )
                    if (vm.mode == AuthMode.SignUp && state.site.inviteOnly) {
                        Field(stringResource(R.string.auth_invite_code), vm.inviteCode, { vm.inviteCode = it }, err["invite_code"], null, last = true, onDone = vm::submit)
                    }
                    if (vm.mode == AuthMode.LogIn && site.passwordReset) {
                        TextButton(onClick = { vm.switch(AuthMode.Forgot) }, modifier = Modifier.align(Alignment.End)) { Text(stringResource(R.string.auth_forgot_password)) }
                    }
                    Text(
                        vm.formError,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    Button(onClick = { if (!vm.busy) vm.submit() }, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                        Text(
                            when {
                                vm.busy && vm.mode == AuthMode.LogIn -> stringResource(R.string.auth_logging_in)
                                vm.busy -> stringResource(R.string.auth_signing_up)
                                vm.mode == AuthMode.LogIn -> stringResource(R.string.auth_log_in)
                                else -> stringResource(R.string.auth_sign_up)
                            },
                        )
                    }
                }
                TextButton(onClick = onGuest, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                    Text(stringResource(R.string.auth_just_looking))
                }
                if (accounts != null && others.isNotEmpty()) {
                    Text(stringResource(R.string.auth_other_accounts), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp).semantics { heading() })
                    for (a in others) {
                        val user = a.user ?: continue
                        Row(
                            Modifier.fillMaxWidth().clickable(enabled = !vm.busy) { accounts.scope.launch { accounts.switchTo(a.id) } }.padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Avatar(user, 36.dp, url = a.avatarUrl)
                            Column {
                                Text(user.name)
                                Text(serverLabel(a.server), style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Forgot password (§39): the email to send the link to, then where it went. */
@Composable
private fun ForgotPassword(vm: AuthViewModel) {
    Text(stringResource(R.string.auth_reset_password), style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
    if (vm.sentTo.isNotEmpty()) {
        Text(
            stringResource(R.string.auth_link_sent, vm.sentTo),
            color = Chirkle.colors.muted,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
    } else {
        Text(stringResource(R.string.auth_forgot_hint), color = Chirkle.colors.muted)
        Field(stringResource(R.string.auth_email), vm.email, { vm.email = it }, vm.fieldErrors["email"], ContentType.EmailAddress, KeyboardType.Email, last = true, onDone = vm::submit)
        Text(vm.formError, color = MaterialTheme.colorScheme.error, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        Button(onClick = { if (!vm.busy) vm.submit() }, modifier = Modifier.fillMaxWidth().height(48.dp)) {
            Text(stringResource(if (vm.busy) R.string.auth_sending else R.string.auth_send_link))
        }
    }
    TextButton(onClick = { vm.switch(AuthMode.LogIn) }, enabled = !vm.busy, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.auth_back_to_log_in)) }
}

@Composable
private fun Field(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    error: String?,
    type: ContentType?,
    keyboard: KeyboardType = KeyboardType.Text,
    password: Boolean = false,
    last: Boolean = false,
    onDone: () -> Unit = {},
) {
    var shown by androidx.compose.runtime.saveable.rememberSaveable { androidx.compose.runtime.mutableStateOf(false) }
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        singleLine = true,
        isError = error != null,
        supportingText = error?.let { { Text(it) } },
        trailingIcon = if (!password) null else ({
            androidx.compose.material3.IconButton(onClick = { shown = !shown }) {
                androidx.compose.material3.Icon(if (shown) chirkle.android.ui.ChirkleIcons.Hide else chirkle.android.ui.ChirkleIcons.Show, contentDescription = stringResource(if (shown) R.string.auth_hide_password else R.string.auth_show_password))
            }
        }),
        visualTransformation = if (password && !shown) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = keyboard, imeAction = if (last) ImeAction.Done else ImeAction.Next, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        modifier = Modifier.fillMaxWidth().semantics {
            if (type != null) contentType = type
            if (error != null) error(error)
        },
    )
}
