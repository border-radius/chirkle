// The composer (ANDROID.md §7.2, DESIGN.md §22.3): a multi-line field with the 2,000-character limit counted in code
// points, emoji, attach and send. Enter makes a new line; with a hardware keyboard Enter sends, Shift+Enter is a new
// line, Up in an empty field edits your last message and Ctrl+Up/Down pick the reply, as on the web. Typing ":name"
// offers emoji by name in a strip over the field (DESIGN.md §20.6).
package chirkle.android.feature.room

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
    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(Limits.ATTACHMENTS)) { vm.attach(it) }
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { vm.attach(it) }
    var attachMenu by remember { mutableStateOf(false) }
    Surface(color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxWidth()) {
            vm.editing?.let {
                Bar("Edit message", "Enter to save · Esc to cancel", "Cancel edit", vm::cancelEdit)
            }
            vm.replyTo?.let { r ->
                Bar("Replying to ${r.expand?.author?.name ?: "Unknown"}", r.quote().line(), "Cancel reply", vm::cancelReply)
            }
            if (vm.attachments.isNotEmpty() || vm.items.isNotEmpty() || vm.preparing.isNotEmpty()) {
                LazyRow(Modifier.padding(horizontal = 8.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    items(vm.attachments, key = { it.uri }) { f ->
                        // An image shows itself; other files their name.
                        if (f.type.startsWith("image/")) {
                            Box(Modifier.size(64.dp)) {
                                coil3.compose.AsyncImage(
                                    java.io.File(f.uri),
                                    contentDescription = f.name,
                                    contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                                    modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainerHighest),
                                )
                                Box(
                                    Modifier
                                        .align(Alignment.TopEnd)
                                        .padding(3.dp)
                                        .size(22.dp)
                                        .clip(androidx.compose.foundation.shape.CircleShape)
                                        .background(Color.Black.copy(alpha = 0.6f))
                                        .clickable { vm.removeAttachment(f) }
                                        .semantics { contentDescription = "Remove ${f.name}" },
                                    contentAlignment = Alignment.Center,
                                ) { Icon(ChirkleIcons.Close, contentDescription = null, tint = Color.White, modifier = Modifier.size(14.dp)) }
                            }
                            return@items
                        }
                        InputChip(
                            selected = false,
                            onClick = { vm.removeAttachment(f) },
                            label = { Text(f.name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.width(120.dp)) },
                            trailingIcon = { Icon(ChirkleIcons.Close, contentDescription = "Remove ${f.name}", modifier = Modifier.size(16.dp)) },
                        )
                    }
                    // Videos being compressed (VideoPrep): × stops one.
                    items(vm.preparing, key = { "prep-" + it.id }) { p ->
                        InputChip(
                            selected = false,
                            onClick = { vm.cancelPreparing(p) },
                            label = {
                                Text(
                                    if (p.progress < 0) "Waiting: ${p.name}" else "Compressing ${p.progress}%: ${p.name}",
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.width(160.dp),
                                )
                            },
                            trailingIcon = { Icon(ChirkleIcons.Close, contentDescription = "Remove ${p.name}", modifier = Modifier.size(16.dp)) },
                        )
                    }
                    // From a collection (§31.3): after the uploads, as the server attaches them.
                    items(vm.items, key = { "item-" + it.id }) { it ->
                        Box(Modifier.size(64.dp)) {
                            chirkle.android.ui.ItemPicture(it, Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)).semantics { contentDescription = it.name + ", from a collection" })
                            Box(
                                Modifier
                                    .align(Alignment.TopEnd)
                                    .padding(3.dp)
                                    .size(22.dp)
                                    .clip(androidx.compose.foundation.shape.CircleShape)
                                    .background(Color.Black.copy(alpha = 0.6f))
                                    .clickable { vm.removeItem(it) }
                                    .semantics { contentDescription = "Remove ${it.name}" },
                                contentAlignment = Alignment.Center,
                            ) { Icon(ChirkleIcons.Close, contentDescription = null, tint = Color.White, modifier = Modifier.size(14.dp)) }
                        }
                    }
                }
            }
            val n = textLength(vm.text.text)
            val error = vm.composerError.ifEmpty { if (n > Limits.MESSAGE_TEXT) "Too long: ${n - Limits.MESSAGE_TEXT} characters over the ${Limits.MESSAGE_TEXT} limit." else "" }
            if (error.isNotEmpty()) {
                Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp).semantics { liveRegion = LiveRegionMode.Polite })
            }
            if (vm.suggestions.isNotEmpty()) Suggestions(vm)
            // One rounded field with emoji at its start and attach at its end, both kept at the bottom as the text
            // grows, then Send: the text gets the width, as in the messengers people know.
            Row(Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 12.dp), verticalAlignment = Alignment.Bottom) {
                Row(
                    Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(26.dp))
                        .background(MaterialTheme.colorScheme.surfaceContainer)
                        .heightIn(min = 52.dp)
                        .padding(horizontal = 4.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    IconButton(onClick = onEmoji) { Icon(ChirkleIcons.Emoji, contentDescription = "Insert emoji", tint = Chirkle.colors.muted) }
                    val textColor = MaterialTheme.colorScheme.onSurface
                    BasicTextField(
                        value = vm.text,
                        onValueChange = vm::onText,
                        maxLines = 6,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = textColor, lineHeight = 22.sp),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        modifier = Modifier
                            .weight(1f)
                            .padding(vertical = 13.dp)
                            .focusRequester(focus)
                            .semantics { contentDescription = "Message" }
                            .onPreviewKeyEvent { e ->
                                if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                                val plain = !e.isShiftPressed && !e.isCtrlPressed && !e.isAltPressed && !e.isMetaPressed
                                if (vm.suggestions.isNotEmpty()) when {
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
                        decorationBox = { field ->
                            Box {
                                if (vm.text.text.isEmpty()) {
                                    Text(placeholder, style = MaterialTheme.typography.bodyLarge.copy(lineHeight = 22.sp), color = Chirkle.colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                                field()
                            }
                        },
                    )
                    if (vm.editing == null) {
                        Box {
                            IconButton(onClick = { attachMenu = true }) { Icon(ChirkleIcons.Attach, contentDescription = "Attach files", tint = Chirkle.colors.muted) }
                            DropdownMenu(attachMenu, onDismissRequest = { attachMenu = false }) {
                                DropdownMenuItem(text = { Text("Photos and videos") }, leadingIcon = { Icon(ChirkleIcons.Image, contentDescription = null) }, onClick = {
                                    attachMenu = false
                                    pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                                })
                                DropdownMenuItem(text = { Text("Files") }, leadingIcon = { Icon(ChirkleIcons.File, contentDescription = null) }, onClick = { attachMenu = false; pickFiles.launch(arrayOf("*/*")) })
                                if (onCollections != null) {
                                    DropdownMenuItem(
                                        text = { Text("From a collection") },
                                        leadingIcon = { Icon(ChirkleIcons.Collection, contentDescription = null) },
                                        onClick = { attachMenu = false; onCollections() },
                                    )
                                }
                            }
                        }
                    } else {
                        Spacer(Modifier.width(12.dp))
                    }
                }
                val canSend = (!isBlank(vm.text.text) || ((vm.attachments.isNotEmpty() || vm.items.isNotEmpty()) && vm.editing == null)) && n <= Limits.MESSAGE_TEXT && vm.preparing.isEmpty()
                Spacer(Modifier.width(8.dp))
                // A rounded square in the accent fill; dimmed while there is nothing to send.
                val bg by androidx.compose.animation.animateColorAsState(if (canSend) Chirkle.colors.fill else Chirkle.colors.fill.copy(alpha = 0.25f), label = "send")
                val fg by androidx.compose.animation.animateColorAsState(if (canSend) Chirkle.colors.onFill else Color.White.copy(alpha = 0.55f), label = "sendIcon")
                androidx.compose.material3.FilledIconButton(
                    onClick = vm::submit,
                    enabled = canSend,
                    shape = RoundedCornerShape(18.dp),
                    colors = androidx.compose.material3.IconButtonDefaults.filledIconButtonColors(containerColor = bg, contentColor = fg, disabledContainerColor = bg, disabledContentColor = fg),
                    modifier = Modifier.size(52.dp),
                ) {
                    Icon(if (vm.editing != null) ChirkleIcons.Check else ChirkleIcons.Send, contentDescription = if (vm.editing != null) "Save" else "Send", modifier = Modifier.size(20.dp))
                }
            }
        }
    }
}

/** The emoji a ":name" finds, in a row over the field: a tap puts one in; the chosen one (for Enter) is tinted. */
@Composable
private fun Suggestions(vm: RoomViewModel) {
    val list = androidx.compose.foundation.lazy.rememberLazyListState()
    androidx.compose.runtime.LaunchedEffect(vm.suggestion) { list.animateScrollToItem(vm.suggestion) }
    LazyRow(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(top = 6.dp).semantics { contentDescription = "Emoji" },
        state = list,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        itemsIndexed(vm.suggestions, key = { _, n -> n.emoji }) { i, n ->
            Row(
                Modifier
                    .clip(RoundedCornerShape(18.dp))
                    .background(if (i == vm.suggestion) Chirkle.colors.tint else MaterialTheme.colorScheme.surfaceContainer)
                    .clickable(onClickLabel = "Insert") { vm.pickSuggestion(i) }
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

@Composable
private fun Bar(title: String, detail: String, cancel: String, onCancel: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(3.dp).heightIn(min = 32.dp).background(MaterialTheme.colorScheme.primary, RoundedCornerShape(2.dp)))
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
            Text(detail, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Chirkle.colors.muted)
        }
        IconButton(onClick = onCancel) { Icon(ChirkleIcons.Close, contentDescription = cancel) }
    }
    HorizontalDivider(color = Chirkle.colors.border)
}
