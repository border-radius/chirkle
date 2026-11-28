// The composer (ANDROID.md §7.2, DESIGN.md §22.3): a multi-line field with the 2,000-character limit counted in code
// points, emoji, attach and send. Enter makes a new line; with a hardware keyboard Enter sends, Shift+Enter is a new
// line, Up in an empty field edits your last message and Ctrl+Up/Down pick the reply, as on the web. Typing ":name"
// offers emoji by name in a strip over the field (DESIGN.md §20.6).
package chirkle.android.feature.room

import android.content.res.Configuration
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import chirkle.android.data.lib.Limits
import chirkle.android.data.lib.isBlank
import chirkle.android.data.lib.quote
import chirkle.android.data.lib.line
import chirkle.android.data.lib.textLength
import chirkle.android.ui.Chirkle
import chirkle.android.ui.ChirkleIcons

@Composable
fun Composer(vm: RoomViewModel, placeholder: String, focus: FocusRequester, onCollections: (() -> Unit)? = null, onEmoji: () -> Unit) {
    val res = LocalContext.current.resources
    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(Limits.ATTACHMENTS)) { vm.attach(it) }
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { vm.attach(it) }
    var attachMenu by remember { mutableStateOf(false) }
    // Wrapped onto a second line, the text gets the box's whole width and the buttons a row of their own under it (the
    // web's room view redesign on a phone, 2026-11-23); back on one row once the text is shorter than when it wrapped,
    // so they don't flip with every letter.
    var wrappedAt by remember { mutableStateOf(-1) }
    if (wrappedAt >= 0 && vm.text.text.length < wrappedAt) wrappedAt = -1
    val wrapped = wrappedAt >= 0
    // Frosted glass over the list (the list scrolls under it): the pane at 72 %; Compose has no backdrop blur before
    // Android 12, so the tint alone.
    Surface(color = MaterialTheme.colorScheme.surface.copy(alpha = GLASS)) {
        Column(Modifier.fillMaxWidth()) {
            val n = textLength(vm.text.text)
            val error = vm.composerError.ifEmpty { if (n > Limits.MESSAGE_TEXT) stringResource(R.string.room_too_long_characters_over_the, n - Limits.MESSAGE_TEXT, Limits.MESSAGE_TEXT) else "" }
            if (error.isNotEmpty()) {
                Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp).semantics { liveRegion = LiveRegionMode.Polite })
            }
            if (vm.people.isNotEmpty()) People(vm) else if (vm.suggestions.isNotEmpty()) Suggestions(vm)
            // One filled box 8 dp in from the sides: the reply's (or edit's) header as its first row, the text, emoji ·
            // attach · send at its end, then the attachments as square tiles.
            Column(
                Modifier
                    .padding(start = 8.dp, end = 8.dp, top = 6.dp, bottom = 8.dp)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(24.dp))
                    .background(MaterialTheme.colorScheme.surfaceContainer)
                    .padding(horizontal = 4.dp, vertical = 2.dp),
            ) {
                vm.editing?.let {
                    // "Enter to save · Esc to cancel" only with a hardware keyboard: on the screen's, Enter makes a new
                    // line and there is no Esc (QA BUG-297). Otherwise the message being edited, as the reply bar shows its quote.
                    val config = LocalConfiguration.current
                    val keys = config.keyboard == Configuration.KEYBOARD_QWERTY && config.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO
                    Bar(
                        stringResource(R.string.room_edit_message),
                        if (keys) stringResource(R.string.room_enter_to_save_esc_to) else it.quote().line(),
                        stringResource(R.string.room_cancel_edit),
                        vm::cancelEdit,
                    )
                }
                vm.replyTo?.let { r ->
                    Bar(stringResource(R.string.room_replying_to, r.expand?.author?.name ?: stringResource(R.string.room_unknown)), r.quote().line(), stringResource(R.string.room_cancel_reply), vm::cancelReply)
                }
                val canSend = (!isBlank(vm.text.text) || ((vm.attachments.isNotEmpty() || vm.items.isNotEmpty()) && vm.editing == null)) && n <= Limits.MESSAGE_TEXT && vm.preparing.isEmpty()
                val field = @Composable { m: Modifier ->
                    val textColor = MaterialTheme.colorScheme.onSurface
                    BasicTextField(
                        value = vm.text,
                        onValueChange = vm::onText,
                        maxLines = 6,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = textColor, lineHeight = 22.sp),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        onTextLayout = { if (it.lineCount > 1 && wrappedAt < 0) wrappedAt = vm.text.text.length },
                        modifier = m
                            .padding(start = 12.dp, end = 4.dp, top = 13.dp, bottom = 13.dp)
                            .focusRequester(focus)
                            .semantics { contentDescription = res.getString(R.string.room_message) }
                            .onPreviewKeyEvent { e ->
                                if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                                val plain = !e.isShiftPressed && !e.isCtrlPressed && !e.isAltPressed && !e.isMetaPressed
                                if (vm.suggesting) when {
                                    (e.key == Key.Enter || e.key == Key.Tab) && plain -> return@onPreviewKeyEvent true.also { vm.pickSuggestion() }
                                    e.key == Key.DirectionDown && plain -> return@onPreviewKeyEvent true.also { vm.stepSuggestion(1) }
                                    e.key == Key.DirectionUp && plain -> return@onPreviewKeyEvent true.also { vm.stepSuggestion(-1) }
                                    e.key == Key.Escape -> return@onPreviewKeyEvent true.also { vm.dismissSuggestions() }
                                }
                                when {
                                    e.key == Key.Enter && !e.isShiftPressed -> { vm.submit(); true }
                                    e.key == Key.Escape && vm.editing != null -> { vm.cancelEdit(); true }
                                    e.key == Key.Escape && vm.replyTo != null -> { vm.cancelReply(); true }
                                    e.key == Key.DirectionUp && e.isCtrlPressed -> { vm.moveReply(up = true); true }
                                    e.key == Key.DirectionDown && e.isCtrlPressed -> { vm.moveReply(up = false); true }
                                    e.key == Key.DirectionUp && vm.text.text.isEmpty() -> vm.editLast()
                                    else -> false
                                }
                            },
                        decorationBox = { inner ->
                            Box {
                                if (vm.text.text.isEmpty()) {
                                    Text(placeholder, style = MaterialTheme.typography.bodyLarge.copy(lineHeight = 22.sp), color = Chirkle.colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                                inner()
                            }
                        },
                    )
                }
                val buttons = @Composable {
                    IconButton(onClick = onEmoji) { Icon(ChirkleIcons.Emoji, contentDescription = stringResource(R.string.room_insert_emoji), tint = Chirkle.colors.muted) }
                    if (vm.editing == null) {
                        Box {
                            IconButton(onClick = { attachMenu = true }) { Icon(ChirkleIcons.Attach, contentDescription = stringResource(R.string.room_attach_files), tint = Chirkle.colors.muted) }
                            DropdownMenu(attachMenu, onDismissRequest = { attachMenu = false }) {
                                DropdownMenuItem(text = { Text(stringResource(R.string.room_photos_and_videos)) }, leadingIcon = { Icon(ChirkleIcons.Image, contentDescription = null) }, onClick = {
                                    attachMenu = false
                                    pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                                })
                                DropdownMenuItem(text = { Text(stringResource(R.string.room_files)) }, leadingIcon = { Icon(ChirkleIcons.File, contentDescription = null) }, onClick = { attachMenu = false; pickFiles.launch(arrayOf("*/*")) })
                                if (onCollections != null) {
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.room_from_a_collection)) },
                                        leadingIcon = { Icon(ChirkleIcons.Collection, contentDescription = null) },
                                        onClick = { attachMenu = false; onCollections() },
                                    )
                                }
                            }
                        }
                    }
                    // A bare arrow in the accent, faint while there is nothing to send.
                    val tint by androidx.compose.animation.animateColorAsState(if (canSend) MaterialTheme.colorScheme.primary else Chirkle.colors.dim.copy(alpha = 0.5f), label = "send")
                    IconButton(onClick = vm::submit, enabled = canSend) {
                        Icon(
                            if (vm.editing != null) ChirkleIcons.Check else ChirkleIcons.Send,
                            contentDescription = if (vm.editing != null) stringResource(R.string.room_save) else stringResource(R.string.room_send),
                            tint = tint,
                            modifier = Modifier.size(22.dp),
                        )
                    }
                }
                if (wrapped) {
                    field(Modifier.fillMaxWidth())
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) { buttons() }
                } else {
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.Bottom) {
                        field(Modifier.weight(1f))
                        buttons()
                    }
                }
                if (vm.attachments.isNotEmpty() || vm.items.isNotEmpty() || vm.preparing.isNotEmpty()) {
                    LazyRow(Modifier.padding(start = 8.dp, end = 8.dp, top = 2.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        items(vm.attachments, key = { it.uri }) { f ->
                            // An image shows itself; other files their icon and name.
                            Tile(res.getString(R.string.room_remove, f.name), { vm.removeAttachment(f) }) {
                                if (f.type.startsWith("image/")) {
                                    coil3.compose.AsyncImage(
                                        java.io.File(f.uri),
                                        contentDescription = f.name,
                                        contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                                        modifier = Modifier.fillMaxSize(),
                                    )
                                } else {
                                    TileLabel(ChirkleIcons.File, f.name)
                                }
                            }
                        }
                        // Videos being compressed (VideoPrep): × stops one.
                        items(vm.preparing, key = { "prep-" + it.id }) { p ->
                            Tile(res.getString(R.string.room_remove, p.name), { vm.cancelPreparing(p) }) {
                                TileLabel(
                                    null,
                                    if (p.progress < 0) stringResource(R.string.room_waiting, p.name) else stringResource(R.string.room_compressing, p.progress, p.name),
                                    busy = true,
                                )
                            }
                        }
                        // From a collection (§31.3): after the uploads, as the server attaches them.
                        items(vm.items, key = { "item-" + it.id }) { it ->
                            Tile(res.getString(R.string.room_remove, it.name), { vm.removeItem(it) }) {
                                chirkle.android.ui.ItemPicture(it, Modifier.fillMaxSize().semantics { contentDescription = it.name + res.getString(R.string.room_from_a_collection_2) })
                            }
                        }
                    }
                }
            }
        }
    }
}

/** How opaque the room's glass is (the web's `--glass`: 72 % of the pane). */
internal const val GLASS = 0.72f

/** An attachment's 72 dp square tile with a corner × that takes it out ([remove]: what the × says). */
@Composable
private fun Tile(remove: String, onRemove: () -> Unit, content: @Composable () -> Unit) {
    Box(Modifier.size(72.dp).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainerHighest)) {
        content()
        // A 22 dp × in the corner, touched anywhere in the 48 dp around it (§13's touch targets).
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .size(48.dp)
                .clickable(onClick = onRemove)
                .semantics { contentDescription = remove },
            contentAlignment = Alignment.TopEnd,
        ) {
            Box(
                Modifier.padding(3.dp).size(22.dp).clip(androidx.compose.foundation.shape.CircleShape).background(Color.Black.copy(alpha = 0.6f)),
                contentAlignment = Alignment.Center,
            ) { Icon(ChirkleIcons.Close, contentDescription = null, tint = Color.White, modifier = Modifier.size(14.dp)) }
        }
    }
}

/** A tile without a picture: an icon (or a spinner while [busy]) over its name, small. */
@Composable
private fun TileLabel(icon: androidx.compose.ui.graphics.vector.ImageVector?, text: String, busy: Boolean = false) {
    Column(Modifier.fillMaxSize().padding(6.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        if (busy) androidx.compose.material3.CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        else if (icon != null) Icon(icon, contentDescription = null, tint = Chirkle.colors.muted, modifier = Modifier.size(20.dp))
        Spacer(Modifier.size(4.dp))
        Text(text, style = MaterialTheme.typography.labelSmall, maxLines = 2, overflow = TextOverflow.Ellipsis, color = Chirkle.colors.muted, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}

/** The emoji a ":name" finds, in a row over the field: a tap puts one in; the chosen one (for Enter) is tinted. */
@Composable
private fun Suggestions(vm: RoomViewModel) {
    val res = LocalContext.current.resources
    val list = androidx.compose.foundation.lazy.rememberLazyListState()
    androidx.compose.runtime.LaunchedEffect(vm.suggestion) { list.animateScrollToItem(vm.suggestion) }
    LazyRow(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(top = 6.dp).semantics { contentDescription = res.getString(R.string.room_emoji) },
        state = list,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        itemsIndexed(vm.suggestions, key = { _, n -> n.emoji }) { i, n ->
            Row(
                Modifier
                    .clip(RoundedCornerShape(18.dp))
                    .background(if (i == vm.suggestion) Chirkle.colors.tint else MaterialTheme.colorScheme.surfaceContainer)
                    .clickable(onClickLabel = stringResource(R.string.room_insert)) { vm.pickSuggestion(i) }
                    .padding(horizontal = 10.dp, vertical = 6.dp)
                    .semantics(mergeDescendants = true) { contentDescription = "${n.emoji} ${n.name}" },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(n.emoji, fontSize = 20.sp)
                Spacer(Modifier.width(6.dp))
                Text(":${n.name}:", style = MaterialTheme.typography.bodyMedium, color = Chirkle.colors.muted)
            }
        }
    }
}

/**
 * The people an "@" finds (DESIGN.md §41), in a column over the field: a tap puts their handle in; the chosen one is
 * tinted. At most about four rows high, scrolling past them: eight filled a phone's screen over its keyboard, squashing
 * the field and the top bar (QA BUG-253).
 */
@Composable
private fun People(vm: RoomViewModel) {
    val res = LocalContext.current.resources
    val scroll = androidx.compose.foundation.rememberScrollState()
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp)
            .padding(top = 6.dp)
            .heightIn(max = PEOPLE_MAX_HEIGHT)
            .clip(RoundedCornerShape(16.dp))
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .verticalScroll(scroll)
            .semantics { contentDescription = res.getString(R.string.room_people) },
    ) {
        vm.people.forEachIndexed { i, u ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(if (i == vm.suggestion) Chirkle.colors.tint else Color.Transparent)
                    .clickable(onClickLabel = stringResource(R.string.room_mention)) { vm.pickPerson(i) }
                    .padding(horizontal = 12.dp, vertical = 8.dp)
                    .semantics(mergeDescendants = true) { contentDescription = "${u.name} @${u.handle}" },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                chirkle.android.ui.Avatar(chirkle.android.data.model.User(u.id, u.name, u.avatar, instance = u.instance, handle = u.handle), 28.dp)
                Spacer(Modifier.width(10.dp))
                Text(u.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Spacer(Modifier.width(8.dp))
                Text("@${u.handle}", style = MaterialTheme.typography.bodyMedium, color = Chirkle.colors.muted, maxLines = 1)
            }
        }
    }
}

/** How high the "@" list grows: four rows and half of the next, which says there are more. */
private val PEOPLE_MAX_HEIGHT = 200.dp

@Composable
private fun Bar(title: String, detail: String, cancel: String, onCancel: () -> Unit) {
    // The box's first row (the room view redesign): who and the quote, two lines on a phone, and ×.
    Row(Modifier.fillMaxWidth().padding(start = 12.dp, top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
            Text(detail, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Chirkle.colors.muted)
        }
        IconButton(onClick = onCancel) { Icon(ChirkleIcons.Close, contentDescription = cancel, tint = Chirkle.colors.muted) }
    }
}
