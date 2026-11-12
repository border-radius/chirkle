// A room or DM (ANDROID.md §7, §7.1; web/src/views/room.ts): the message list laid out from the bottom, the composer
// or why you can't post, search (§29), selecting messages to forward or delete (§21), and the room's menu.
package chirkle.android.feature.room

import android.content.ClipData
import android.content.Context
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import chirkle.android.data.lib.PageKind
import chirkle.android.data.lib.Side
import chirkle.android.data.lib.attachmentName
import chirkle.android.data.lib.canManage
import chirkle.android.data.lib.canPost
import chirkle.android.data.lib.dmClosed
import chirkle.android.data.lib.highlight
import chirkle.android.data.lib.label
import chirkle.android.data.lib.otherMember
import chirkle.android.data.lib.title
import chirkle.android.data.lib.sharedNote
import chirkle.android.data.lib.visibilityOrDefault
import chirkle.android.data.model.Message
import chirkle.android.data.model.Visibility
import chirkle.android.data.repo.Phase
import chirkle.android.data.repo.Pill
import chirkle.android.data.repo.Scroll
import chirkle.android.ui.Chirkle
import chirkle.android.ui.ChirkleIcons
import chirkle.android.ui.Formats
import chirkle.android.ui.LocalServices
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** Where the room screen sends you. */
class RoomNav(
    val back: () -> Unit,
    val openRoom: (String) -> Unit,
    val access: (String) -> Unit,
    val viewer: (roomId: String, msgId: String, file: String) -> Unit,
    val logIn: () -> Unit,
    val media: (String) -> Unit = {},
    /** A collection's page (§31.3). */
    val collection: (String) -> Unit = {},
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoomScreen(roomId: String, msgId: String?, nav: RoomNav, incoming: Pair<String, List<Uri>>? = null, onIncomingTaken: () -> Unit = {}) {
    val services = LocalServices.current
    val context = LocalContext.current
    val app = context.applicationContext as android.app.Application
    val vm: RoomViewModel = viewModel(key = "room-$roomId-$msgId") { RoomViewModel(app, services, roomId, msgId) }
    val c = vm.controller
    val state by c.state.collectAsStateWithLifecycle()
    val rows by vm.rows.collectAsStateWithLifecycle()
    val app_ by services.store.flow.collectAsStateWithLifecycle()
    val progress by c.progress.collectAsStateWithLifecycle()
    val busy by c.busy.collectAsStateWithLifecycle(false)
    val recent by services.recentEmoji.list.collectAsStateWithLifecycle()
    val room = app_.rooms[roomId]
    val me = app_.user
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val focus = remember { FocusRequester() }
    val clipboard = LocalClipboard.current
    val focusManager = androidx.compose.ui.platform.LocalFocusManager.current
    var sheetFor by remember { mutableStateOf<Message?>(null) }
    var emojiFor by remember { mutableStateOf<Message?>(null) }
    var composerEmoji by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<List<String>?>(null) }
    var forwarding by remember { mutableStateOf<List<String>?>(null) }
    /** A moderator's Ban, asked first (DESIGN.md §36): the author's id and name. */
    var banning by remember { mutableStateOf<Pair<String, String>?>(null) }
    var saving by remember { mutableStateOf<chirkle.android.data.model.SaveFrom?>(null) }
    var pickingItems by remember { mutableStateOf(false) }
    val badges by vm.badges.state.collectAsStateWithLifecycle()
    var roomMenu by remember { mutableStateOf(false) }

    // Back undoes the mode you are in before it leaves the room: selection, search, then an edit.
    androidx.activity.compose.BackHandler(enabled = vm.selecting, onBack = vm::clearSelection)
    androidx.activity.compose.BackHandler(enabled = !vm.selecting && vm.searching, onBack = vm::closeSearch)
    androidx.activity.compose.BackHandler(enabled = !vm.selecting && !vm.searching && vm.editing != null, onBack = vm::cancelEdit)

    val atBottom by remember { derivedStateOf { list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset < 64 } }
    // The newest saved message shown whole (§18.3). The list is laid out from the bottom: an item's offset is from there.
    val shown by remember {
        derivedStateOf {
            val info = list.layoutInfo
            info.visibleItemsInfo.firstNotNullOfOrNull { item ->
                if (item.offset < info.viewportStartOffset) null else (rows.getOrNull(item.index) as? ListRow.Msg)?.m?.takeIf { it.status == null }
            }
        }
    }
    // A new list shows its newest rows until the controller's first scroll puts it where the room opens (the first
    // unread message): what it shows before that isn't read. Opening at the bottom, there is nothing to wait for.
    var scrolled by remember { mutableStateOf(false) }
    val placed = scrolled || (state.unreadId == null && state.targetId == null)
    // Also on coming back: what arrived while the app was in the background (realtime stays up for a while) is read
    // once it is on screen again (QA BUG-157).
    LaunchedEffect(atBottom, shown?.id, placed, rows, app_.away) { vm.onScrolled(atBottom, shown, placed) }
    // The newest row the list has been given (composed, so its next layout has it), for Scroll.Bottom to wait on.
    val composedFirst = remember { kotlinx.coroutines.flow.MutableStateFlow<String?>(null) }
    androidx.compose.runtime.SideEffect { composedFirst.value = (rows.firstOrNull() as? ListRow.Msg)?.m?.id }
    // Shared into the app (§9.3): into the composer, as if typed and attached here.
    LaunchedEffect(incoming) {
        val (text, uris) = incoming ?: return@LaunchedEffect
        if (text.isNotBlank()) vm.onText(androidx.compose.ui.text.input.TextFieldValue(text, androidx.compose.ui.text.TextRange(text.length)))
        if (uris.isNotEmpty()) vm.attach(uris)
        onIncomingTaken()
    }
    // The badges the window's files need (§31.3), asked once each.
    LaunchedEffect(state.items) { vm.badges.want(state.items.flatMap { it.fileSources.values }) }
    // A message deleted (or gone from the list) while its menu or reaction picker is open: they close, rather than
    // offer what the server would refuse (the web's QA BUG-121; BUG-156).
    LaunchedEffect(state.items, sheetFor, emojiFor) {
        fun gone(m: Message?) = m != null && state.items.none { it.id == m.id && !it.deleted }
        if (gone(sheetFor)) sheetFor = null
        if (gone(emojiFor)) emojiFor = null
    }
    LaunchedEffect(vm.toast) { vm.toast?.let { snackbar.showSnackbar(it); vm.toast = null } }

    // The list nears an end: extend the window there.
    LaunchedEffect(list) {
        snapshotFlow { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index to list.layoutInfo.totalItemsCount }
            .distinctUntilChanged()
            .collect { (last, total) -> if (last != null && total > 0 && last >= total - 10) c.loadEdge(Side.Top) }
    }
    LaunchedEffect(list) {
        snapshotFlow { list.firstVisibleItemIndex }.distinctUntilChanged().collect { if (it < 10 && c.state.value.hasNewer) c.loadEdge(Side.Bottom) }
    }
    // What the controller asks of the list after a change. One scroll that fails (the list changed under it) must not
    // end the scrolling for good.
    LaunchedEffect(c) {
        c.scrolls.collect { s ->
            runCatching {
                when (s) {
                    Scroll.Bottom -> {
                        // Wait until the list has the newest row: scrolled before that, the list keeps the row that
                        // was at the bottom in place, and a message just sent lands below the composer.
                        val newest = c.state.value.items.lastOrNull()?.id
                        if (newest != null) withTimeoutOrNull(1000) { composedFirst.first { it == newest } }
                        list.scrollToItem(0)
                    }
                    Scroll.Top -> withTimeoutOrNull(1000) { vm.rows.first { it.isNotEmpty() } }?.let { list.scrollToItem(it.lastIndex) }
                    Scroll.Target -> {
                        val key = c.state.value.targetId ?: c.state.value.unreadId ?: return@runCatching
                        val rowsNow = withTimeoutOrNull(1000) { vm.rows.first { r -> r.any { it.key == key } } } ?: return@runCatching
                        // The list is laid out from the bottom: the target's bottom edge at the bottom, then raised a
                        // quarter of the list so what follows it shows too, as far as the target stays whole. (Two rows
                        // newer at the bottom put it off screen when they are tall: images, a keyboard open.)
                        val i = rowsNow.indexOfFirst { it.key == key }
                        list.scrollToItem(i)
                        val info = list.layoutInfo
                        val size = info.visibleItemsInfo.firstOrNull { it.index == i }?.size ?: 0
                        val viewport = info.viewportEndOffset - info.viewportStartOffset
                        val raise = minOf(viewport / 4, viewport - size).coerceAtLeast(0)
                        if (raise > 0 && i > 0) list.scrollBy(-raise.toFloat())
                    }
                    Scroll.Anchor -> {}
                }
            }
            scrolled = true
        }
    }

    val names = remember(state.items, room) {
        val map = HashMap<String, String>()
        room?.expand?.members?.forEach { map[it.id] = it.name }
        for (m in state.items) m.expand?.author?.let { map[it.id] = it.name }
        map
    }
    val actions = RowActions(
        onLongPress = { m -> if (vm.selecting) vm.toggleSelect(m) else if (m.status == null && !m.isService) sheetFor = m },
        onTap = { m -> if (vm.selecting) vm.toggleSelect(m) },
        onQuote = { id, from -> c.goTo(id, from) },
        onReact = { m, e -> vm.react(m, e) },
        onRetry = { c.retrySend(it.id) },
        onDiscard = { c.discard(it.id) },
        onOpenMedia = { m, f -> nav.viewer(roomId, m.id, f) },
        onFile = { m, f -> scope.launch { download(context, services, m, f) } },
        reactions = { c.reactions(it) },
        name = { names[it] },
        progress = { progress[it] },
        onAddReaction = if (me == null || room?.archived == true) null else ({ m -> if (!vm.selecting && c.reactable(m)) emojiFor = m }),
        // A forward's files are its original's (§21.3).
        onSave = if (me == null) null else ({ m, f -> saving = chirkle.android.data.model.SaveFrom.File(m.forwardOf.ifEmpty { m.id }, f) }),
        badge = { badges[it] },
        onCollection = nav.collection,
        myHandle = me?.handle.orEmpty(),
    )

    Scaffold(
        // Swiping the room to the right goes back to the rooms, unless a mode (selection, search) is open.
        modifier = Modifier.swipeBack(enabled = !vm.selecting && !vm.searching, onBack = nav.back)
            // Ctrl+/ from a hardware keyboard: to the composer, as on the web (§7.6). Nothing while there is none (a banner).
            .onPreviewKeyEvent { e ->
                e.type == KeyEventType.KeyDown && e.isCtrlPressed && !e.isAltPressed && e.key == Key.Slash &&
                    runCatching { focus.requestFocus() }.isSuccess
            },
        topBar = {
            when {
                vm.selecting -> TopAppBar(
                    navigationIcon = { IconButton(onClick = vm::clearSelection) { Icon(ChirkleIcons.Close, contentDescription = "Cancel") } },
                    title = { Text("${vm.selected.size} selected", modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) },
                    actions = {
                        if (me != null) IconButton(onClick = { forwarding = vm.selected.toList() }) { Icon(ChirkleIcons.Forward, contentDescription = "Forward") }
                        if (vm.canDeleteSelected) IconButton(onClick = { confirmDelete = vm.selected.toList() }) { Icon(ChirkleIcons.Delete, contentDescription = "Delete") }
                    },
                )
                vm.searching -> TopAppBar(
                    navigationIcon = { IconButton(onClick = vm::closeSearch) { Icon(ChirkleIcons.Back, contentDescription = "Close search") } },
                    title = {
                        val searchFocus = remember { FocusRequester() }
                        LaunchedEffect(Unit) { searchFocus.requestFocus() }
                        TextField(
                            vm.query,
                            vm::onQuery,
                            placeholder = { Text("Search ${room?.title(me?.id) ?: ""}", maxLines = 1) },
                            singleLine = true,
                            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = { vm.searchNow() }),
                            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Search),
                            colors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent),
                            modifier = Modifier
                                .fillMaxWidth()
                                .focusRequester(searchFocus)
                                .onFocusChanged { if (it.isFocused) vm.showResults() }
                                .semantics { contentDescription = "Search messages" },
                        )
                    },
                )
                else -> TopAppBar(
                    navigationIcon = { IconButton(onClick = nav.back) { Icon(ChirkleIcons.Back, contentDescription = "Back to rooms") } },
                    title = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            // A DM shows who it is with.
                            if (room != null && room.isDm) room.otherMember(me?.id)?.let { chirkle.android.ui.Avatar(it, 36.dp, Modifier.padding(end = 12.dp)) }
                            Column(Modifier.clickable(enabled = room != null && !room.isDm) { nav.access(roomId) }) {
                                // A room's "#" quieter than its name.
                                val t = room?.title(me?.id) ?: ""
                                val dim = Chirkle.colors.dim
                                Text(
                                    if (room != null && !room.isDm && t.startsWith("#")) androidx.compose.ui.text.buildAnnotatedString {
                                        pushStyle(androidx.compose.ui.text.SpanStyle(color = dim, fontWeight = FontWeight.SemiBold)); append("#"); pop(); append(t.drop(1))
                                    } else androidx.compose.ui.text.AnnotatedString(t),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    fontWeight = FontWeight.Bold,
                                )
                                if (room != null && !room.isDm) {
                                    Text(
                                        room.visibilityOrDefault.label + if (room.visibilityOrDefault == Visibility.Private) " · ${room.members.size} ${if (room.members.size == 1) "member" else "members"}" else "",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = Chirkle.colors.muted,
                                    )
                                }
                                // Where else a shared room is held, and whether its home answers (§33.9, §33.7).
                                val shared = room?.sharedNote().orEmpty()
                                if (shared.isNotEmpty()) Text(shared, style = MaterialTheme.typography.labelMedium, color = Chirkle.colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    },
                    actions = {
                        if (room != null) IconButton(onClick = { nav.media(roomId) }) { Icon(ChirkleIcons.Image, contentDescription = "Media") }
                        if (room != null) IconButton(onClick = vm::openSearch) { Icon(ChirkleIcons.Search, contentDescription = "Search messages") }
                        if (room != null) {
                            Box {
                                IconButton(onClick = { roomMenu = true }) { Icon(ChirkleIcons.More, contentDescription = "Room actions") }
                                RoomMenu(roomMenu, { roomMenu = false }, room, me != null, room.canManage(me), app_.hidden.containsKey(roomId), nav, snackbar) { c.jump(PageKind.First) }
                            }
                        }
                    },
                )
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            Box(Modifier.navigationBarsPadding().imePadding()) {
                when {
                    room == null || state.phase == Phase.NotFound -> {}
                    me == null -> ReadOnly("You're reading as a guest. ", "Log in", ChirkleIcons.Globe, nav.logIn)
                    room.archived -> ReadOnly("This room is archived. History is read-only.", icon = ChirkleIcons.Archive)
                    !room.canPost(me.id) -> ReadOnly("Only some people can post in this room. You can read along and react.")
                    room.dmClosed(me).isNotEmpty() -> ReadOnly(room.dmClosed(me), icon = ChirkleIcons.Close)
                    vm.selecting -> {}
                    else -> Composer(vm, "Message ${room.title(me.id)}", focus, onCollections = { pickingItems = true }) { composerEmoji = true }
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (state.phase) {
                Phase.Loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                Phase.NotFound -> Centered(if (room == null && app_.rooms.isNotEmpty()) "You can't see this room any more." else "This room doesn't exist.")
                Phase.Failed -> Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Couldn't load this room. Check your connection. ")
                    TextButton(onClick = c::retry) { Text("Retry") }
                }
                Phase.Ready -> {
                    LazyColumn(state = list, reverseLayout = true, contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 8.dp), modifier = Modifier.fillMaxSize().semantics { contentDescription = "Messages" }) {
                        items(rows, key = { it.key }, contentType = { it::class }) { row ->
                            when (row) {
                                is ListRow.Msg -> MessageRow(row.m, row.first, row.target, me?.id, vm.selecting, row.m.id in vm.selected, actions)
                                is ListRow.Day -> DayHeader(row.label)
                                ListRow.NewLine -> NewLine()
                                is ListRow.Beginning -> Beginning(row.text, room, me?.id)
                            }
                        }
                    }
                    if (state.notice.isNotEmpty()) {
                        Surface(Modifier.align(Alignment.TopCenter).padding(8.dp), tonalElevation = 4.dp, shape = MaterialTheme.shapes.medium) {
                            Text(state.notice, modifier = Modifier.padding(12.dp).semantics { liveRegion = LiveRegionMode.Polite })
                        }
                    }
                    // After following quotes it steps back through the replies, one per tap (DESIGN.md §19.5).
                    val back = state.back != null
                    if (back || state.pill != null || !atBottom || state.hasNewer) {
                        val label = if (back) "Back to reply" else if (state.pill != null) "New messages · Jump to latest" else "Jump to latest"
                        SmallFloatingActionButton(
                            onClick = {
                                if (back) return@SmallFloatingActionButton c.goBack()
                                if (state.hasNewer) c.jump(PageKind.Latest) else scope.launch { list.animateScrollToItem(0) }
                                c.dismissPill()
                            },
                            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp).semantics { contentDescription = label },
                        ) {
                            Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                if (back) Text("Back", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(end = 4.dp))
                                else if (state.pill != null) Text("New", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(end = 4.dp))
                                Icon(ChirkleIcons.Down, contentDescription = null)
                            }
                        }
                    }
                }
            }
            // Picking a result puts the keyboard away too: it would cover half of the message gone to.
            if (vm.searching) SearchResults(vm) { focusManager.clearFocus(); vm.pick(it) }
            // A fetch that takes a while (§58); not over the first load's spinner.
            else chirkle.android.ui.LoadingLine(busy && state.phase != Phase.Loading, Modifier.align(Alignment.TopCenter))
        }
    }

    sheetFor?.let { m ->
        val author = m.expand?.author
        val bannable = me?.moderator == true && author != null && m.author != me.id && m.author != m.room && author.instance.isEmpty()
        val banned by produceState<Boolean?>(null, m.id, bannable) {
            value = if (bannable) runCatching { services.api.isBanned(m.author) }.getOrNull() else null
        }
        val items = buildList {
            if (c.repliable(m)) add(MenuItem("Reply", ChirkleIcons.Reply) { sheetFor = null; vm.reply(m); focus.requestFocusSafely() })
            if (c.editable(m)) add(MenuItem("Edit", ChirkleIcons.Edit) { sheetFor = null; vm.startEdit(m); focus.requestFocusSafely() })
            if (m.text.isNotEmpty() && !m.deleted) add(MenuItem("Copy text", ChirkleIcons.Copy) {
                sheetFor = null
                scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("message", m.text))) }
            })
            if (me != null && c.selectable(m)) add(MenuItem("Forward", ChirkleIcons.Forward) { sheetFor = null; forwarding = listOf(m.id) })
            if (c.selectable(m)) add(MenuItem("Select", ChirkleIcons.Check) { sheetFor = null; vm.toggleSelect(m) })
            if (c.deletable(m)) add(MenuItem("Delete", ChirkleIcons.Delete, danger = true) { sheetFor = null; confirmDelete = listOf(m.id) })
            // A moderator bans this instance's people, those who take no DMs too (QA BUG-230); an anonymous room's author
            // is the room (§35), no one to ban. The server refuses a Telegram stand-in, and says so.
            val name = author?.name.orEmpty()
            when (banned) {
                false -> add(MenuItem("Ban $name", ChirkleIcons.Lock, danger = true) { sheetFor = null; banning = m.author to name })
                true -> add(MenuItem("Unban $name", ChirkleIcons.Lock) { sheetFor = null; vm.setBanned(m.author, false) })
                null -> {}
            }
        }
        MessageSheet(m, c.reactable(m), recent, items, onReact = { e -> sheetFor = null; vm.react(m, e) }, onMoreEmoji = { sheetFor = null; emojiFor = m }, onDismiss = { sheetFor = null })
    }
    emojiFor?.let { m -> EmojiSheet("Add reaction", recent, onPick = { e -> emojiFor = null; vm.react(m, e) }, onDismiss = { emojiFor = null }) }
    if (composerEmoji) EmojiSheet("Insert emoji", recent, onPick = { e -> composerEmoji = false; vm.insert(e); services.recentEmoji.remember(e) }, onDismiss = { composerEmoji = false })
    confirmDelete?.let { ids ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text(if (ids.size == 1) "Delete message" else "Delete these messages?") },
            text = { Text(if (ids.size == 1) "Delete this message? Everyone will see that it was deleted." else "Delete these ${ids.size} messages? Everyone will see that they were deleted.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = null
                    if (ids.size == 1 && !vm.selecting) c.find(ids[0])?.let(vm::delete) else vm.deleteSelected()
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }
    banning?.let { (id, name) ->
        AlertDialog(
            onDismissRequest = { banning = null },
            title = { Text("Ban $name") },
            text = { Text("Ban $name? They are signed out everywhere and can't sign in until unbanned.") },
            confirmButton = {
                TextButton(onClick = { banning = null; vm.setBanned(id, true) }) { Text("Ban", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { banning = null }) { Text("Cancel") } },
        )
    }
    saving?.let { from -> chirkle.android.ui.SaveToCollectionSheet(from) { saving = null } }
    if (pickingItems) CollectionPickerSheet(vm.filesLeft, onPick = { pickingItems = false; vm.attachItems(it) }) { pickingItems = false }
    forwarding?.let { ids ->
        ForwardSheet(ids.size, forwardTargets(app_), me?.id, onPick = { to -> forwarding = null; vm.forward(ids, to) }, onDismiss = { forwarding = null })
    }
}

private const val NEW_LINE_FADE_MS = 700L

private fun FocusRequester.requestFocusSafely() {
    runCatching { requestFocus() }
}

@Composable
private fun RoomMenu(open: Boolean, close: () -> Unit, room: chirkle.android.data.model.Room, signedIn: Boolean, manage: Boolean, hidden: Boolean, nav: RoomNav, snackbar: SnackbarHostState, toBeginning: () -> Unit) {
    val services = LocalServices.current
    val scope = rememberCoroutineScope()
    var archive by remember { mutableStateOf(false) }
    val every by services.notifyRooms.set.collectAsStateWithLifecycle()
    fun act(label: String, block: suspend () -> Unit) {
        close()
        scope.launch { runCatching { block() }.onFailure { snackbar.showSnackbar("That didn't work. ${chirkle.android.data.api.errorMessage(it)}") } }
    }
    DropdownMenu(open, onDismissRequest = close) {
        // A guest gets only Jump to beginning (DESIGN.md §23.3).
        if (signedIn) {
            // Its access for its creator (or a moderator); its members for the others, only in a private room: a public or
            // Open Air room has none, and its screen was empty (QA BUG-274; the web's menu, header.ts).
            if (!room.isDm && (manage || room.visibility == chirkle.android.data.model.Visibility.Private)) {
                DropdownMenuItem(text = { Text(if (manage) "Room access…" else "Members (${room.members.size})") }, leadingIcon = { Icon(ChirkleIcons.People, contentDescription = null) }, onClick = { close(); nav.access(room.id) })
            }
            if (room.isDm) DropdownMenuItem(text = { Text("Close conversation") }, leadingIcon = { Icon(ChirkleIcons.Hide, contentDescription = null) }, onClick = { act("close") { services.actions.hide(room.id); nav.back() } })
            else if (hidden) DropdownMenuItem(text = { Text("Unhide room") }, leadingIcon = { Icon(ChirkleIcons.Show, contentDescription = null) }, onClick = { act("unhide") { services.actions.unhide(room.id) } })
            // Hiding an archived room is pointless: it is listed under Hidden & archived already (the web's menu).
            else if (!room.archived) DropdownMenuItem(text = { Text("Hide room") }, leadingIcon = { Icon(ChirkleIcons.Hide, contentDescription = null) }, onClick = { act("hide") { services.actions.hide(room.id); nav.back() } })
        }
        // Every message of this room notifies, on this device (§24); DMs all do already.
        if (signedIn && !room.isDm && (!room.archived || room.id in every)) {
            val on = room.id in every
            DropdownMenuItem(
                text = { Text(if (on) "Stop notifying of every message" else "Notify of every message") },
                leadingIcon = { Icon(if (on) ChirkleIcons.BellOff else ChirkleIcons.Bell, contentDescription = null) },
                onClick = { close(); services.notifyRooms.set(room.id, !on) },
            )
        }
        // Its creator's, or a moderator's (DESIGN.md §36).
        if (manage) {
            if (room.archived) DropdownMenuItem(text = { Text("Unarchive room") }, leadingIcon = { Icon(ChirkleIcons.Archive, contentDescription = null) }, onClick = { act("unarchive") { services.actions.setArchived(room.id, false) } })
            else DropdownMenuItem(text = { Text("Archive room") }, leadingIcon = { Icon(ChirkleIcons.Archive, contentDescription = null) }, onClick = { close(); archive = true })
        }
        // The first page, at the top (DESIGN.md §7.1), as the web's menu has it.
        DropdownMenuItem(text = { Text("Jump to beginning") }, leadingIcon = { Icon(ChirkleIcons.Top, contentDescription = null) }, onClick = { close(); toBeginning() })
    }
    if (archive) {
        AlertDialog(
            onDismissRequest = { archive = false },
            title = { Text("Archive room") },
            text = { Text("Archive “${room.name}”? It becomes read-only for everyone.") },
            confirmButton = { TextButton(onClick = { archive = false; act("archive") { services.actions.setArchived(room.id, true) } }) { Text("Archive") } },
            dismissButton = { TextButton(onClick = { archive = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun ReadOnly(text: String, action: String? = null, icon: androidx.compose.ui.graphics.vector.ImageVector = ChirkleIcons.Lock, onAction: () -> Unit = {}) {
    // In place of the composer: why you can't post, after its icon (the web's .guest-banner).
    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column {
            HorizontalDivider(color = Chirkle.colors.border)
            Row(
                Modifier.fillMaxWidth().heightIn(min = 68.dp).padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(icon, contentDescription = null, tint = Chirkle.colors.muted, modifier = Modifier.size(20.dp))
                Text(text, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
                if (action != null) Button(onClick = onAction) { Text(action) }
            }
        }
    }
}

@Composable
private fun Centered(text: String) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) { Text(text, textAlign = TextAlign.Center) }
}

@Composable
private fun DayHeader(label: String) {
    // A chip in the middle (the 2026-10-31 redesign), not a ruled line.
    Box(Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 12.dp), contentAlignment = Alignment.Center) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .background(MaterialTheme.colorScheme.surfaceContainer, androidx.compose.foundation.shape.RoundedCornerShape(12.dp))
                .padding(horizontal = 12.dp, vertical = 4.dp)
                .semantics { heading() },
        )
    }
}

/** The start of the history: the room's picture over "Beginning of …". */
@Composable
private fun Beginning(text: String, room: chirkle.android.data.model.Room?, me: String?) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        if (room != null) chirkle.android.ui.RoomPicture(room, me, 56.dp)
        Text(text, color = Chirkle.colors.muted, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 12.dp))
    }
}

/**
 * The line fades out in its last moments, in its own place, instead of vanishing. (Faded out as it left the list, it
 * was drawn over the message under it while the list closed the gap.)
 */
@Composable
private fun NewLine() {
    val alpha = remember { androidx.compose.animation.core.Animatable(1f) }
    LaunchedEffect(Unit) {
        kotlinx.coroutines.delay(chirkle.android.data.repo.UNREAD_LINE_MS - NEW_LINE_FADE_MS)
        alpha.animateTo(0f, androidx.compose.animation.core.tween(NEW_LINE_FADE_MS.toInt()))
    }
    Row(
        Modifier.fillMaxWidth().graphicsLayer { this.alpha = alpha.value }.padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        HorizontalDivider(Modifier.weight(1f), color = Chirkle.colors.new.copy(alpha = 0.45f))
        Text(
            "NEW",
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            letterSpacing = androidx.compose.ui.unit.TextUnit(0.04f, androidx.compose.ui.unit.TextUnitType.Em),
            color = Chirkle.colors.new,
            modifier = Modifier.semantics { contentDescription = "New" },
        )
    }
}

@Composable
private fun SearchResults(vm: RoomViewModel, onPick: (Message) -> Unit) {
    if (!vm.resultsShown || (vm.query.isBlank() && vm.results.isEmpty())) return
    Surface(Modifier.fillMaxWidth().heightIn(max = 420.dp), tonalElevation = 3.dp, shadowElevation = 6.dp) {
        LazyColumn(Modifier.semantics { contentDescription = "Search results" }) {
            item { Text(vm.searchStatus, color = Chirkle.colors.muted, modifier = Modifier.padding(16.dp).semantics { liveRegion = LiveRegionMode.Polite }) }
            items(vm.results, key = { it.id }) { m ->
                val accent = MaterialTheme.colorScheme.primary
                Column(Modifier.fillMaxWidth().clickable { onPick(m) }.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        m.expand?.author?.let { Text(it.name, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium) }
                        Text(Formats.time(m.created), color = Chirkle.colors.muted, style = MaterialTheme.typography.labelSmall)
                    }
                    val parts = highlight(m.text, vm.searchWordsShown)
                    Text(
                        androidx.compose.ui.text.buildAnnotatedString {
                            parts.forEachIndexed { i, s ->
                                if (i % 2 == 1) pushStyle(androidx.compose.ui.text.SpanStyle(background = Chirkle.colors.highlight, fontWeight = FontWeight.Bold))
                                append(s)
                                if (i % 2 == 1) pop()
                            }
                        },
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (vm.moreResults) item { TextButton(onClick = vm::searchMore, modifier = Modifier.padding(8.dp)) { Text("Show older results") } }
        }
    }
}


/** Download an attachment with the system's download manager (a fresh file token in its URL, §17.3). */
private suspend fun download(context: Context, services: chirkle.android.data.repo.ChirkleServices, m: Message, file: String) {
    val token = runCatching { services.tokens.ensure() }.getOrDefault("")
    chirkle.android.ui.download(context, services.api.fileUrl(m, file, token = token).toString(), m.attachmentName(file))
}
