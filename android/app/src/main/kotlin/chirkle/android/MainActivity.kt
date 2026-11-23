// The one activity (ANDROID.md §7): the navigation, links to rooms and messages (App Links, §9.4; notifications), shares
// (§9.3), the notification permission, and FLAG_SECURE when the user asked for it (§10).
package chirkle.android

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.core.content.edit
import androidx.core.graphics.drawable.toDrawable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import chirkle.android.data.repo.ThemeChoice
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import chirkle.android.nav.AppRoot
import chirkle.android.nav.Linked
import chirkle.android.notify.Notifications
import chirkle.android.nav.ShareInbox
import chirkle.android.nav.notificationRoute
import chirkle.android.nav.routeOf
import chirkle.android.ui.ChirkleTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    /** A room the last intent asked for (a link, a notification), in its account. */
    private var linked by mutableStateOf<Linked?>(null)
    private var ready by mutableStateOf(false)
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    /**
     * The theme chosen last time, kept where it can be read before the first frame: the accounts' index is read off the
     * main thread, so without it a dark choice would start with a light window.
     */
    private val uiPrefs by lazy { getSharedPreferences("ui", MODE_PRIVATE) }

    private fun isDark(t: ThemeChoice) = when (t) {
        ThemeChoice.Light -> false
        ThemeChoice.Dark -> true
        ThemeChoice.System -> (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
    }

    /** The window behind Compose, the system bars' icons and (Android 12+) the splash screen, in [t]'s colours. */
    private fun applyTheme(t: ThemeChoice) {
        val dark = isDark(t)
        window.setBackgroundDrawable((if (dark) 0xFF1A1726.toInt() else 0xFFFFFFFF.toInt()).toDrawable())
        val style = if (dark) SystemBarStyle.dark(Color.TRANSPARENT) else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
        enableEdgeToEdge(style, style)
        if (Build.VERSION.SDK_INT >= 31) {
            getSystemService(android.app.UiModeManager::class.java)?.setApplicationNightMode(
                when (t) {
                    ThemeChoice.Light -> android.app.UiModeManager.MODE_NIGHT_NO
                    ThemeChoice.Dark -> android.app.UiModeManager.MODE_NIGHT_YES
                    ThemeChoice.System -> android.app.UiModeManager.MODE_NIGHT_AUTO
                },
            )
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val saved = ThemeChoice.of(uiPrefs.getString("theme", null))
        applyTheme(saved)
        super.onCreate(savedInstanceState)
        val app = ChirkleApp.of(this)
        app.start()
        if (savedInstanceState == null) take(intent)
        lifecycleScope.launch {
            app.ready.await()
            ready = true
            app.accounts.settings.secureScreens.collect { secure ->
                if (secure) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
        }
        setContent {
            val stored by app.accounts.settings.theme.collectAsStateWithLifecycle()
            // Until the settings are read, last time's choice.
            val theme = if (ready) stored else saved
            val dark = when (theme) {
                ThemeChoice.Light -> false
                ThemeChoice.Dark -> true
                ThemeChoice.System -> isSystemInDarkTheme()
            }
            // The system bars' icons follow the app's theme, not the system's.
            LaunchedEffect(theme, dark) {
                applyTheme(theme)
                if (ready) uiPrefs.edit { putString("theme", theme.name) }
            }
            val textSize by app.accounts.settings.textSize.collectAsStateWithLifecycle()
            ChirkleTheme(dark) {
                // Text size (DESIGN.md §7.8): the whole interface scales with it (every dp and sp), as the web's rem.
                val density = androidx.compose.ui.platform.LocalDensity.current
                androidx.compose.runtime.CompositionLocalProvider(
                    androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(density.density * textSize.scale, density.fontScale),
                ) {
                    // Nothing but the theme's background until the stored session is read (a few ms).
                    if (ready) AppRoot(app.accounts, linked = linked, onLinkTaken = { linked = null }, onSignedIn = ::askForNotifications)
                }
                LaunchedEffect(Unit) { reportFullyDrawnWhenReady(app) }
            }
        }
    }

    private suspend fun reportFullyDrawnWhenReady(app: ChirkleApp) {
        app.ready.await()
        reportFullyDrawn()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        take(intent)
    }

    private fun take(intent: Intent?) {
        intent ?: return
        ShareInbox.read(intent)?.let { ShareInbox.pending = it; return }
        val app = ChirkleApp.of(this)
        if (intent.action == Notifications.OPEN) {
            val account = intent.getStringExtra("account") ?: return
            val room = notificationRoute(intent.component?.className, intent.getStringExtra("room"), intent.getStringExtra("msg")) ?: return
            return open(account, room)
        }
        val url = intent.data?.toString() ?: return
        lifecycleScope.launch {
            app.ready.await()
            // The account on the link's server (ANDROID.md §17.3).
            val (account, path) = app.accounts.forLink(url) ?: return@launch
            routeOf(path)?.let { open(account, it) }
        }
    }

    /** Show [room] (or a collection) in [account], switching to it. */
    private fun open(account: String, room: androidx.navigation3.runtime.NavKey) {
        val app = ChirkleApp.of(this)
        lifecycleScope.launch {
            app.ready.await()
            app.accounts.switchTo(account)
            if (app.accounts.active.value?.accountId == account) linked = Linked(account, room)
        }
    }

    /** Notifications need the permission on Android 13+: asked once someone is signed in (not at first launch). */
    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
