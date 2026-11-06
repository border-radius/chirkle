// Your profile (DESIGN.md §15, §22.1–2; web/src/views/profile.ts): picture, display name, the theme, this device's
// setting for keeping messages out of screenshots (§10), password, log out. Your accounts (ANDROID.md §17) are on
// their own screen (AccountsScreen), opened from the brand on the room list.
package chirkle.android.feature.profile

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import chirkle.android.data.api.ApiError
import chirkle.android.data.api.errorMessage
import chirkle.android.data.lib.Limits
import chirkle.android.data.lib.textLength
import chirkle.android.data.pb.UploadFile
import chirkle.android.ui.Avatar
import chirkle.android.ui.Chirkle
import chirkle.android.ui.ChirkleIcons
import chirkle.android.ui.ImagePrep
import chirkle.android.ui.LocalServices
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import chirkle.android.data.repo.ThemeChoice
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File

/** Why a new password can't be used, or none (the server checks again). */
fun passwordProblem(current: String, next: String, confirm: String): Map<String, String> = when {
    current.isEmpty() -> mapOf("current" to "Enter your current password.")
    next.length < Limits.PASSWORD_MIN -> mapOf("next" to "Must be at least ${Limits.PASSWORD_MIN} characters.")
    next == current -> mapOf("next" to "That is your current password. Choose a new one.")
    confirm != next -> mapOf("confirm" to "The passwords don't match.")
    else -> emptyMap()
}

private fun fieldMessage(e: Throwable, field: String) = (e as? ApiError)?.fields?.get(field) ?: errorMessage(e)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(onBack: () -> Unit) {
    val services = LocalServices.current
    val context = LocalContext.current
    val s by services.store.flow.collectAsStateWithLifecycle()
    val secure by services.settings.secureScreens.collectAsStateWithLifecycle()
    val me = s.user ?: return
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var avatarError by remember { mutableStateOf("") }
    var name by remember(me.id) { mutableStateOf(me.name) }
    var nameStatus by remember { mutableStateOf("") }
    var nameError by remember { mutableStateOf(false) }
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var pwErrors by remember { mutableStateOf(emptyMap<String, String>()) }
    var pwStatus by remember { mutableStateOf("") }

    fun upload(uri: Uri?) {
        if (uri == null || busy) return
        avatarError = ""
        val type = context.contentResolver.getType(uri) ?: ""
        if (type !in Limits.AVATAR_TYPES) {
            avatarError = "Choose a JPEG, PNG, WebP or GIF image."
            return
        }
        busy = true
        scope.launch {
            // A picture that can't be read (gone from the provider, no longer allowed) says so; thrown here, it would
            // end the app.
            val prepared = withContext(Dispatchers.IO) {
                runCatching {
                    val dir = File(context.cacheDir, "avatar").apply { deleteRecursively(); mkdirs() }
                    val raw = File(dir, "avatar." + (type.substringAfter('/')))
                    context.contentResolver.openInputStream(uri)!!.use { i -> raw.outputStream().use { i.copyTo(it) } }
                    ImagePrep.prepare(raw, raw.name, type, ImagePrep.AVATAR_EDGE) ?: Triple(raw, raw.name, type)
                }.getOrNull()
            }
            if (prepared == null) {
                avatarError = "Couldn't read that image."
                busy = false
                return@launch
            }
            val (file, fname, ftype) = prepared
            if (file.length() > Limits.AVATAR_BYTES) {
                avatarError = "That image is too large (max ${Limits.AVATAR_BYTES / 1024 / 1024} MB)."
                busy = false
                return@launch
            }
            runCatching { services.api.setAvatar(UploadFile(fname, ftype, file.asRequestBody(ftype.toMediaTypeOrNull()))) }
                .onFailure { avatarError = fieldMessage(it, "avatar") }
            busy = false
        }
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { upload(it) }

    Scaffold(topBar = {
        TopAppBar(
            navigationIcon = { IconButton(onClick = onBack) { Icon(ChirkleIcons.Back, contentDescription = "Back to rooms") } },
            title = { Text("Your profile") },
        )
    }) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(Modifier.widthIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // Picture and name together, as the web's Settings has them: the field says what it is.
                Section("Profile")
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Avatar(me, 96.dp)
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, enabled = !busy) { Text("Change picture") }
                        if (me.avatar.isNotEmpty()) OutlinedButton(onClick = {
                            busy = true
                            scope.launch {
                                runCatching { services.api.removeAvatar() }.onFailure { avatarError = fieldMessage(it, "avatar") }
                                busy = false
                            }
                        }, enabled = !busy) { Text("Remove") }
                    }
                }
                if (avatarError.isNotEmpty()) Text(avatarError, color = MaterialTheme.colorScheme.error, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                OutlinedTextField(
                    name,
                    { name = it; nameStatus = ""; nameError = false },
                    label = { Text("Display name") },
                    singleLine = true,
                    isError = nameError,
                    supportingText = if (nameStatus.isNotEmpty()) ({ Text(nameStatus, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }) else null,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(onClick = {
                    val n = name.trim()
                    val problem = if (n.isEmpty()) "A display name can't be empty." else if (textLength(n) > Limits.USER_NAME) "Must be no more than ${Limits.USER_NAME} characters." else ""
                    nameError = problem.isNotEmpty()
                    nameStatus = problem
                    // Your own name back (after "taken", say): nothing to save, and nothing wrong (QA BUG-56).
                    if (problem.isNotEmpty() || n == me.name) return@Button
                    scope.launch {
                        runCatching { services.api.rename(n) }
                            .onSuccess { name = it.name; nameStatus = "Saved." }
                            .onFailure { nameStatus = fieldMessage(it, "name"); nameError = true }
                    }
                }) { Text("Save") }
                HorizontalDivider(color = Chirkle.colors.border)

                Section("Appearance")
                val theme by services.settings.theme.collectAsStateWithLifecycle()
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    ThemeChoice.entries.forEachIndexed { i, t ->
                        SegmentedButton(
                            selected = theme == t,
                            onClick = { services.settings.setTheme(t) },
                            shape = SegmentedButtonDefaults.itemShape(i, ThemeChoice.entries.size),
                            label = { Text(t.label) },
                        )
                    }
                }
                HorizontalDivider(color = Chirkle.colors.border)

                Section("This device")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Hide messages from screenshots")
                        Text("Screens with messages can't be captured, and are blank in recent apps.", style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted)
                    }
                    Switch(secure, onCheckedChange = services.settings::setSecureScreens)
                }
                HorizontalDivider(color = Chirkle.colors.border)

                Section("Password")
                PasswordField("Current password", current, pwErrors["current"]) { current = it }
                PasswordField("New password", next, pwErrors["next"]) { next = it }
                PasswordField("Confirm new password", confirm, pwErrors["confirm"]) { confirm = it }
                if (pwStatus.isNotEmpty()) Text(pwStatus, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                Button(onClick = {
                    pwStatus = ""
                    pwErrors = passwordProblem(current, next, confirm)
                    if (pwErrors.isNotEmpty()) return@Button
                    scope.launch {
                        runCatching { services.api.changePassword(current, next) }
                            .onSuccess {
                                current = ""; next = ""; confirm = ""
                                pwStatus = "Password changed. You were logged out everywhere else."
                            }
                            .onFailure { e ->
                                val f = (e as? ApiError)?.fields.orEmpty()
                                if (f["oldPassword"] != null || f["password"] != null) {
                                    pwErrors = buildMap { f["oldPassword"]?.let { put("current", it) }; f["password"]?.let { put("next", it) } }
                                } else pwStatus = errorMessage(e)
                            }
                    }
                }) { Text("Change password") }
                HorizontalDivider(color = Chirkle.colors.border)

                Section("Session")
                TextButton(onClick = { scope.launch { services.logOut() } }) { Text("Log out", color = MaterialTheme.colorScheme.error) }
                val version = remember { runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull().orEmpty() }
                Text("${s.site.title} for Android $version", style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted, modifier = Modifier.padding(top = 8.dp))
            }
        }
    }
}

@Composable
private fun Section(title: String) {
    Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
}

@Composable
private fun PasswordField(label: String, value: String, error: String?, onChange: (String) -> Unit) {
    OutlinedTextField(
        value,
        onChange,
        label = { Text(label) },
        singleLine = true,
        isError = error != null,
        supportingText = error?.let { { Text(it) } },
        visualTransformation = PasswordVisualTransformation(),
        modifier = Modifier.fillMaxWidth(),
    )
}
