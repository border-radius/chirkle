// The back stack (ANDROID.md §7: Navigation 3, a back stack we own), one per account (§17): switching accounts starts
// a fresh one. Signed out, the app starts at Log in; a guest who chose to look around gets the Open Air rooms (§23.3).
// Without any account, it asks for a server first (§17.2). An app too old for the server says so (§12.4).
package chirkle.android.nav

import androidx.compose.animation.ContentTransform
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavBackStack
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import chirkle.android.BuildConfig
import chirkle.android.feature.auth.AuthMode
import chirkle.android.feature.auth.AuthScreen
import chirkle.android.feature.profile.AccountsScreen
import chirkle.android.feature.profile.ProfileScreen
import chirkle.android.feature.room.RoomAccessScreen
import chirkle.android.feature.room.RoomNav
import chirkle.android.feature.room.RoomScreen
import chirkle.android.feature.room.forwardTargets
import chirkle.android.feature.rooms.RoomsScreen
import chirkle.android.feature.viewer.ViewerScreen
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.key
import chirkle.android.data.repo.Accounts
import chirkle.android.feature.auth.ServerScreen
import chirkle.android.ui.LocalAccounts
import chirkle.android.ui.LocalServices

/** The active account's screens, or the choice of a server when there is no account yet. */
@Composable
fun AppRoot(accounts: Accounts, linked: Linked?, onLinkTaken: () -> Unit, onSignedIn: () -> Unit) {
    val active by accounts.active.collectAsStateWithLifecycle()
    val list by accounts.list.collectAsStateWithLifecycle()
    CompositionLocalProvider(LocalAccounts provides accounts) {
        val s = active
        when {
            s != null -> key(s.accountId) {
                CompositionLocalProvider(LocalServices provides s) {
                    ChirkleNav(linked?.takeIf { it.account == s.accountId }?.room, onLinkTaken, onSignedIn)
                }
            }
            list.isEmpty() -> ServerScreen(onCancel = null)
            else -> Surface(Modifier.fillMaxSize()) {} // between two accounts
        }
    }
}

@Composable
fun ChirkleNav(linked: NavKey?, onLinkTaken: () -> Unit, onSignedIn: () -> Unit) {
    val services = LocalServices.current
    val s by services.store.flow.collectAsStateWithLifecycle()
    if (s.site.minAndroidVersion > BuildConfig.VERSION_CODE) return UpdateRequired()
    val signedIn = s.user != null
    var guest by rememberSaveable { mutableStateOf(false) }
    val stack = rememberNavBackStack(if (signedIn) Rooms else Login)

    // Signed in or out: a fresh stack (nothing of the last session's screens stays).
    LaunchedEffect(signedIn) {
        if (signedIn) {
            if (stack.firstOrNull() !is Rooms) stack.reset(Rooms)
            onSignedIn()
        } else if (!guest && stack.firstOrNull() !is Login) stack.reset(Login)
        else if (guest && stack.any { it is Profile }) stack.reset(Rooms)
    }
    LaunchedEffect(linked, signedIn) {
        val r = linked ?: return@LaunchedEffect
        if (!signedIn && !guest) guest = true
        stack.reset(Rooms)
        stack += r
        onLinkTaken()
    }
    LaunchedEffect(ShareInbox.pending, signedIn) {
        // Only a share with no room yet: choosing one sets its target, which must not bring the picker back.
        val p = ShareInbox.pending
        if (p != null && p.target == null && signedIn && stack.lastOrNull() !is SharePicker) stack += SharePicker
    }

    NavDisplay(
        backStack = stack,
        onBack = { if (stack.size > 1) stack.removeAt(stack.lastIndex) },
        entryDecorators = listOf(rememberSaveableStateHolderNavEntryDecorator(), rememberViewModelStoreNavEntryDecorator()),
        // Material's shared X axis: the next screen slides in a little from the end and fades in; back reverses it. Your
        // accounts, opened by a swipe to the right, come from the start instead (§52).
        transitionSpec = { forward(FROM_START !in targetState.metadata) },
        popTransitionSpec = { forward(FROM_START in initialState.metadata) },
        predictivePopTransitionSpec = { forward(FROM_START in initialState.metadata) },
        entryProvider = entryProvider {
            entry<Login> { AuthScreen(AuthMode.LogIn, onChangeServer = { stack += ChooseServer }) { guest = true; stack.reset(Rooms) } }
            entry<SignUp> { AuthScreen(AuthMode.SignUp, onChangeServer = { stack += ChooseServer }) { guest = true; stack.reset(Rooms) } }
            entry<ChooseServer> { ServerScreen(onCancel = { stack.removeAt(stack.lastIndex) }) }
            entry<Rooms> {
                RoomsScreen(
                    onOpenRoom = { stack += Room(it) },
                    onProfile = { stack += Profile },
                    onLogIn = { guest = false; stack.reset(Login) },
                    onOpenCollection = { stack += CollectionPage(it) },
                    onAccounts = { stack += AccountList },
                )
            }
            entry<Room> { key ->
                val incoming = ShareInbox.pending?.takeIf { it.target == key.id }
                RoomScreen(
                    key.id,
                    key.msgId,
                    RoomNav(
                        back = { stack.removeAt(stack.lastIndex) },
                        openRoom = { stack += Room(it) },
                        access = { stack += RoomAccess(it) },
                        viewer = { r, m, f -> stack += Viewer(r, m, f) },
                        logIn = { guest = false; stack.reset(Login) },
                        media = { stack += Media(it) },
                        collection = { stack += CollectionPage(it) },
                    ),
                    incoming = incoming?.let { it.text to it.uris },
                    onIncomingTaken = { ShareInbox.pending = null },
                )
            }
            entry<Media> { key ->
                chirkle.android.feature.room.MediaScreen(key.roomId, onOpen = { m, f -> stack += Viewer(key.roomId, m, f) }) { stack.removeAt(stack.lastIndex) }
            }
            entry<CollectionPage> { key ->
                chirkle.android.feature.room.CollectionScreen(key.id, onOpen = { stack += CollectionViewer(key.id, it) }) { stack.removeAt(stack.lastIndex) }
            }
            entry<CollectionViewer> { key ->
                chirkle.android.feature.viewer.CollectionViewerScreen(key.collection, key.item) { stack.removeAt(stack.lastIndex) }
            }
            entry<RoomAccess> { key -> RoomAccessScreen(key.id) { stack.removeAt(stack.lastIndex) } }
            entry<Viewer> { key -> ViewerScreen(key.roomId, key.msgId, key.file) { stack.removeAt(stack.lastIndex) } }
            entry<Profile> { ProfileScreen { stack.removeAt(stack.lastIndex) } }
            entry<AccountList>(metadata = mapOf(FROM_START to true)) { AccountsScreen(onAddAccount = { stack += ChooseServer }) { stack.removeAt(stack.lastIndex) } }
            entry<SharePicker> {
                SharePickerScreen(forwardTargets(s), s.user?.id, onPick = { room ->
                    ShareInbox.pending = ShareInbox.pending?.copy(target = room)
                    stack.removeAt(stack.lastIndex)
                    stack += Room(room)
                }, onCancel = {
                    ShareInbox.pending = null
                    stack.removeAt(stack.lastIndex)
                })
            }
        },
    )
}

/** Entry metadata: the screen slides in from the start, not the end. */
private const val FROM_START = "chirkle.fromStart"

private val Ease = CubicBezierEasing(0.2f, 0f, 0f, 1f)

private fun forward(forward: Boolean): ContentTransform {
    val dir = if (forward) 1 else -1
    val enter = slideInHorizontally(tween(300, easing = Ease)) { dir * it / 5 } + fadeIn(tween(210, delayMillis = 60, easing = LinearEasing))
    val exit = slideOutHorizontally(tween(300, easing = Ease)) { -dir * it / 5 } + fadeOut(tween(90, easing = LinearEasing))
    return enter togetherWith exit
}

private fun NavBackStack<NavKey>.reset(to: NavKey) {
    clear()
    add(to)
}

@Composable
private fun UpdateRequired() {
    val context = LocalContext.current
    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.padding(32.dp), verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Update required", style = MaterialTheme.typography.headlineSmall)
            Text("This version of the app is too old for the server. Update it to go on.")
            Button(onClick = {
                runCatching {
                    context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("market://details?id=${context.packageName}")))
                }
            }) { Text("Update") }
        }
    }
}
