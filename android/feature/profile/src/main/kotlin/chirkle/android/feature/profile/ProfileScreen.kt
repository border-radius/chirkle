// Your profile (DESIGN.md §15, §22.1–2; web/src/views/profile.ts): picture, display name, the theme, this device's
// setting for keeping messages out of screenshots (§10), password, log out, your data and deleting your account (§43). Your accounts (ANDROID.md §17) are on
// their own screen (AccountsScreen), opened from the brand on the room list.
package chirkle.android.feature.profile

import android.content.res.Resources
import androidx.compose.ui.res.stringResource
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
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.ui.semantics.Role
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import chirkle.android.data.api.ApiError
import chirkle.android.data.api.errorMessage
import chirkle.android.data.lib.Limits
import chirkle.android.data.lib.formatBytes
import chirkle.android.data.lib.parsePb
import chirkle.android.data.model.ExportState
import chirkle.android.data.model.ExportStatus
import androidx.compose.runtime.LaunchedEffect
import kotlinx.coroutines.delay
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
import chirkle.android.data.repo.TextSize
import chirkle.android.data.repo.ThemeChoice
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File

/** Why a new password can't be used, or none (the server checks again). */
fun passwordProblem(res: Resources, current: String, next: String, confirm: String): Map<String, String> = when {
    current.isEmpty() -> mapOf("current" to res.getString(R.string.profile_enter_your_current_password))
    next.length < Limits.PASSWORD_MIN -> mapOf("next" to res.getString(R.string.profile_must_be_at_least_characters, Limits.PASSWORD_MIN))
    next == current -> mapOf("next" to res.getString(R.string.profile_that_is_your_current_password))
    confirm != next -> mapOf("confirm" to res.getString(R.string.profile_the_passwords_dont_match))
    else -> emptyMap()
}

private fun fieldMessage(e: Throwable, field: String) = (e as? ApiError)?.fields?.get(field) ?: errorMessage(e)

/** How often the screen asks whether an export being made is made (DESIGN.md §43.2). */
private const val EXPORT_POLL_MS = 3000L

/** A handle as the server takes it (pb_hooks/lib/handles.js HANDLE). */
private val HANDLE = Regex("^[a-z0-9_]{3,24}$")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(onBack: () -> Unit) {
    val res = LocalContext.current.resources
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
    var handle by remember(me.id) { mutableStateOf(me.handle) }
    var handleStatus by remember { mutableStateOf("") }
    var handleError by remember { mutableStateOf(false) }
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var pwErrors by remember { mutableStateOf(emptyMap<String, String>()) }
    var pwStatus by remember { mutableStateOf("") }
    // Your data (§43.2): where the newest export is, and an error of asking for or downloading it.
    var export by remember { mutableStateOf<ExportStatus?>(null) }
    var exportError by remember { mutableStateOf("") }
    /** "Prepare again" answered with the same export (made under 10 minutes ago, §43.2): said, or it looks broken (QA BUG-283). */
    var sameExport by remember { mutableStateOf(false) }
    /** A server from before §43 (its export route a 404): no Your data, no Delete account (QA BUG-285). */
    var noAccountRoutes by remember { mutableStateOf(false) }
    // Delete account (§43.3): null until chosen; true deletes the messages too.
    var delMessages by remember { mutableStateOf<Boolean?>(null) }
    var delChoiceError by remember { mutableStateOf("") }
    var delPassword by remember { mutableStateOf("") }
    var delPasswordError by remember { mutableStateOf<String?>(null) }
    var delStatus by remember { mutableStateOf("") }
    var deleting by remember { mutableStateOf(false) }

    fun upload(uri: Uri?) {
        if (uri == null || busy) return
        avatarError = ""
        val type = context.contentResolver.getType(uri) ?: ""
        if (type !in Limits.AVATAR_TYPES) {
            avatarError = res.getString(R.string.profile_choose_a_jpeg_png_webp)
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
                avatarError = res.getString(R.string.profile_couldnt_read_that_image)
                busy = false
                return@launch
            }
            val (file, fname, ftype) = prepared
            if (file.length() > Limits.AVATAR_BYTES) {
                avatarError = res.getString(R.string.profile_that_image_is_too_large, Limits.AVATAR_BYTES / 1024 / 1024)
                busy = false
                return@launch
            }
            runCatching { services.api.setAvatar(UploadFile(fname, ftype, file.asRequestBody(ftype.toMediaTypeOrNull()))) }
                .onFailure { avatarError = fieldMessage(it, "avatar") }
            busy = false
        }
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { upload(it) }
    // Asked when the screen opens, and again every 3 s while it is being made.
    LaunchedEffect(me.id, export?.state == ExportState.Queued) {
        if (export != null && export?.state != ExportState.Queued) return@LaunchedEffect
        if (export != null) delay(EXPORT_POLL_MS)
        while (true) {
            // Not answered: as if never asked, so Prepare is there to try.
            runCatching { services.api.exportStatus() }.onSuccess { export = it }.onFailure {
                if ((it as? ApiError)?.status == 404) noAccountRoutes = true
                if (export == null) export = ExportStatus()
            }
            if (export?.state != ExportState.Queued) return@LaunchedEffect
            delay(EXPORT_POLL_MS)
        }
    }

    fun deleteAccount() {
        val choice = delMessages
        delStatus = ""
        delChoiceError = if (choice == null) res.getString(R.string.profile_choose_what_happens) else ""
        delPasswordError = if (delPassword.isEmpty()) res.getString(R.string.profile_enter_your_password) else null
        if (choice == null || delPassword.isEmpty()) return
        deleting = true
        delStatus = res.getString(R.string.profile_deleting)
        scope.launch {
            runCatching { services.api.deleteAccount(delPassword, choice) }
                .onSuccess { services.logOut() }
                .onFailure { e ->
                    delStatus = ""
                    val f = (e as? ApiError)?.fields.orEmpty()
                    if (f["password"] != null || f["messages"] != null) {
                        delPasswordError = f["password"]
                        delChoiceError = f["messages"].orEmpty()
                    } else delStatus = errorMessage(e)
                }
            deleting = false
        }
    }

    Scaffold(topBar = {
        TopAppBar(
            navigationIcon = { IconButton(onClick = onBack) { Icon(ChirkleIcons.Back, contentDescription = stringResource(R.string.profile_back_to_rooms)) } },
            title = { Text(stringResource(R.string.profile_your_profile)) },
        )
    }) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(Modifier.widthIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // Picture and name together, as the web's Settings has them: the field says what it is.
                Section(stringResource(R.string.profile_profile))
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Avatar(me, 96.dp)
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, enabled = !busy) { Text(stringResource(R.string.profile_change_picture)) }
                        if (me.avatar.isNotEmpty()) OutlinedButton(onClick = {
                            busy = true
                            scope.launch {
                                runCatching { services.api.removeAvatar() }.onFailure { avatarError = fieldMessage(it, "avatar") }
                                busy = false
                            }
                        }, enabled = !busy) { Text(stringResource(R.string.profile_remove)) }
                    }
                }
                if (avatarError.isNotEmpty()) Text(avatarError, color = MaterialTheme.colorScheme.error, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                OutlinedTextField(
                    name,
                    { name = it; nameStatus = ""; nameError = false },
                    label = { Text(stringResource(R.string.profile_display_name)) },
                    singleLine = true,
                    isError = nameError,
                    supportingText = if (nameStatus.isNotEmpty()) ({ Text(nameStatus, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }) else null,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(onClick = {
                    val n = name.trim()
                    val problem = if (n.isEmpty()) res.getString(R.string.profile_a_display_name_cant_be) else if (textLength(n) > Limits.USER_NAME) res.getString(R.string.profile_must_be_no_more_than, Limits.USER_NAME) else ""
                    nameError = problem.isNotEmpty()
                    nameStatus = problem
                    // Your own name back (after "taken", say): nothing to save, and nothing wrong (QA BUG-56).
                    if (problem.isNotEmpty() || n == me.name) return@Button
                    scope.launch {
                        runCatching { services.api.rename(n) }
                            .onSuccess { name = it.name; nameStatus = res.getString(R.string.profile_saved) }
                            .onFailure { nameStatus = fieldMessage(it, "name"); nameError = true }
                    }
                }) { Text(stringResource(R.string.profile_save)) }
                // What "@handle" names you by (DESIGN.md §41): letters a–z, digits, underscores; an "@" typed is dropped.
                OutlinedTextField(
                    handle,
                    { handle = it; handleStatus = ""; handleError = false },
                    label = { Text(stringResource(R.string.profile_handle)) },
                    prefix = { Text("@") },
                    singleLine = true,
                    isError = handleError,
                    supportingText = { Text(handleStatus.ifEmpty { stringResource(R.string.profile_people_mention_you_as, me.handle) }, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) },
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                        capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = androidx.compose.ui.text.input.KeyboardType.Ascii,
                    ),
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = res.getString(R.string.profile_handle) },
                )
                Button(onClick = {
                    val h = handle.trim().removePrefix("@").lowercase()
                    val problem = if (!HANDLE.matches(h)) res.getString(R.string.profile_use_3_to_24_letters) else ""
                    handleError = problem.isNotEmpty()
                    handleStatus = problem
                    if (problem.isNotEmpty() || h == me.handle) return@Button
                    scope.launch {
                        runCatching { services.api.setHandle(h) }
                            .onSuccess { handle = it.handle; handleStatus = res.getString(R.string.profile_saved) }
                            .onFailure { handleStatus = fieldMessage(it, "handle"); handleError = true }
                    }
                }, modifier = Modifier.semantics { contentDescription = res.getString(R.string.profile_save_handle) }) { Text(stringResource(R.string.profile_save)) }
                HorizontalDivider(color = Chirkle.colors.border)

                Section(stringResource(R.string.profile_appearance))
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

                Section(stringResource(R.string.profile_text_size))
                val textSize by services.settings.textSize.collectAsStateWithLifecycle()
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    TextSize.entries.forEachIndexed { i, z ->
                        SegmentedButton(
                            selected = textSize == z,
                            onClick = { services.settings.setTextSize(z) },
                            shape = SegmentedButtonDefaults.itemShape(i, TextSize.entries.size),
                            label = { Text(z.label) },
                        )
                    }
                }
                HorizontalDivider(color = Chirkle.colors.border)

                Section(stringResource(R.string.profile_this_device))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(R.string.profile_hide_messages_from_screenshots))
                        Text(stringResource(R.string.profile_screens_with_messages_cant_be), style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted)
                    }
                    Switch(secure, onCheckedChange = services.settings::setSecureScreens)
                }
                HorizontalDivider(color = Chirkle.colors.border)

                Section(stringResource(R.string.profile_password))
                PasswordField(stringResource(R.string.profile_current_password), current, pwErrors["current"]) { current = it }
                PasswordField(stringResource(R.string.profile_new_password), next, pwErrors["next"]) { next = it }
                PasswordField(stringResource(R.string.profile_confirm_new_password), confirm, pwErrors["confirm"]) { confirm = it }
                if (pwStatus.isNotEmpty()) Text(pwStatus, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                Button(onClick = {
                    pwStatus = ""
                    pwErrors = passwordProblem(res, current, next, confirm)
                    if (pwErrors.isNotEmpty()) return@Button
                    scope.launch {
                        runCatching { services.api.changePassword(current, next) }
                            .onSuccess {
                                current = ""; next = ""; confirm = ""
                                pwStatus = res.getString(R.string.profile_password_changed_you_were_logged)
                            }
                            .onFailure { e ->
                                val f = (e as? ApiError)?.fields.orEmpty()
                                if (f["oldPassword"] != null || f["password"] != null) {
                                    pwErrors = buildMap { f["oldPassword"]?.let { put("current", it) }; f["password"]?.let { put("next", it) } }
                                } else pwStatus = errorMessage(e)
                            }
                    }
                }) { Text(stringResource(R.string.profile_change_password)) }
                HorizontalDivider(color = Chirkle.colors.border)

                Section(stringResource(R.string.profile_session))
                TextButton(onClick = { scope.launch { services.logOut() } }) { Text(stringResource(R.string.profile_log_out), color = MaterialTheme.colorScheme.error) }
                HorizontalDivider(color = Chirkle.colors.border)

                if (!noAccountRoutes) {
                    Section(stringResource(R.string.profile_your_data))
                    Text(stringResource(R.string.profile_download_hint), style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted)
                    val ex = export
                    val exportLine = when {
                        exportError.isNotEmpty() -> exportError
                        ex?.state == ExportState.Queued -> stringResource(R.string.profile_preparing_your_data)
                        ex?.state == ExportState.Done -> stringResource(
                            R.string.profile_ready_to_download,
                            formatBytes(ex.size),
                            java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT).format(java.util.Date(parsePb(ex.expires))),
                        ) + if (sameExport) " " + stringResource(R.string.profile_still_the_newest) else ""
                        ex?.state == ExportState.Failed -> stringResource(R.string.profile_preparing_failed)
                        else -> ""
                    }
                    if (exportLine.isNotEmpty()) {
                        val bad = exportError.isNotEmpty() || ex?.state == ExportState.Failed
                        Text(exportLine, color = if (bad) MaterialTheme.colorScheme.error else androidx.compose.ui.graphics.Color.Unspecified, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (ex?.state == ExportState.Done) Button(onClick = {
                            exportError = ""
                            scope.launch {
                                // The system's download manager fetches it as it comes, into Downloads (as attachments, §17).
                                runCatching { services.api.exportFileUrl() }
                                    .onSuccess { url ->
                                        val name = "chirkle-export-${ex.created.take(10)}.json"
                                        chirkle.android.ui.download(context, url, name)
                                    }
                                    .onFailure { exportError = errorMessage(it) }
                            }
                        }) { Text(stringResource(R.string.profile_download)) }
                        if (ex != null && ex.state != ExportState.Queued) OutlinedButton(onClick = {
                            exportError = ""
                            sameExport = false
                            val before = ex
                            scope.launch {
                                runCatching { services.api.startExport() }
                                    .onSuccess {
                                        sameExport = it.state == ExportState.Done && before.state == ExportState.Done && it.id == before.id
                                        export = it
                                    }
                                    .onFailure { exportError = errorMessage(it) }
                            }
                        }) { Text(stringResource(if (ex.state == ExportState.Done) R.string.profile_prepare_again else R.string.profile_prepare_my_data)) }
                    }
                    HorizontalDivider(color = Chirkle.colors.border)

                    Section(stringResource(R.string.profile_delete_account))
                    Text(stringResource(R.string.profile_delete_hint), style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted)
                    Column(Modifier.selectableGroup()) {
                        for ((value, label) in listOf(false to R.string.profile_keep_my_messages, true to R.string.profile_delete_my_messages_too)) {
                            Row(
                                Modifier.fillMaxWidth().selectable(selected = delMessages == value, role = Role.RadioButton, onClick = {
                                    delMessages = value
                                    delChoiceError = ""
                                }).padding(vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(selected = delMessages == value, onClick = null)
                                Text(stringResource(label), Modifier.padding(start = 8.dp))
                            }
                        }
                    }
                    if (delChoiceError.isNotEmpty()) Text(delChoiceError, color = MaterialTheme.colorScheme.error, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                    PasswordField(stringResource(R.string.profile_your_password), delPassword, delPasswordError) { delPassword = it; delPasswordError = null }
                    if (delStatus.isNotEmpty()) Text(delStatus, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                    Button(
                        onClick = { deleteAccount() },
                        enabled = !deleting,
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
                    ) { Text(stringResource(R.string.profile_delete_my_account)) }
                }
                val version = remember { runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull().orEmpty() }
                Text(stringResource(R.string.profile_for_android, s.site.title, version), style = MaterialTheme.typography.bodySmall, color = Chirkle.colors.muted, modifier = Modifier.padding(top = 8.dp))
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
