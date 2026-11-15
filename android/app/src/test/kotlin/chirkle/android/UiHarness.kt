package chirkle.android

import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.printToString
import chirkle.android.data.pb.Session
import chirkle.android.data.repo.Accounts
import chirkle.android.data.repo.ChirkleServices
import chirkle.android.data.testing.MemoryAccountEnv
import chirkle.android.data.testing.TestServer
import chirkle.android.nav.AppRoot
import chirkle.android.ui.ChirkleTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

/**
 * The app on [compose], as MainActivity shows it: accounts of its own (ANDROID.md §17) against the test server, the
 * first signed in as [session].
 */
class UiHarness(private val compose: ComposeContentTestRule) {
    var accounts: Accounts? = null

    /** A route a link asked for, as MainActivity passes it (open). */
    private var linked by androidx.compose.runtime.mutableStateOf<chirkle.android.nav.Linked?>(null)

    /** The active account's services. */
    val services: ChirkleServices? get() = accounts?.active?.value

    fun start(session: Session = Session.NONE): ChirkleServices = startWith(listOf(TestServer.url to session))

    /** Accounts on [servers] (server and session each), the first active. */
    fun startWith(servers: List<Pair<String, Session>>): ChirkleServices {
        val a = Accounts(MemoryAccountEnv(servers), OkHttpClient(), Dispatchers.Main.immediate, TestServer.url, allowHttp = true)
        accounts = a
        // The test runs on the main thread: started there, and driven by the rule's idling (never blocked on).
        a.scope.launch { a.start() }
        // In the foreground, as ChirkleApp makes it on a device (ProcessLifecycleOwner never starts here): away, the
        // realtime connection closes after ChirkleServices.BACKGROUND_CLOSE_MS and later live events never come.
        a.setVisible(true)
        compose.setContent { ChirkleTheme { AppRoot(a, linked = linked, onLinkTaken = { linked = null }, onSignedIn = {}) } }
        compose.waitUntil(15_000) { pump(); a.active.value != null }
        return a.active.value!!
    }

    fun signedIn(u: TestServer.TestUser) = start(u.api.pb.authStore.session.value)

    /** Open [route] in the active account, as a link to it does (MainActivity). */
    fun open(route: androidx.navigation3.runtime.NavKey) {
        linked = chirkle.android.nav.Linked(services!!.accountId, route)
        pump()
    }

    fun stop() {
        accounts?.let { a -> a.scope.launch { a.close() } }
        compose.waitForIdle()
    }

    /** Wait for a node [matcher] matches; [merged]: as the screen reader sees nodes (a row's text with its click). */
    fun waitFor(matcher: SemanticsMatcher, ms: Long = 15_000, merged: Boolean = false) = dumping {
        compose.waitUntil(ms) {
            pump()
            compose.onAllNodes(matcher, useUnmergedTree = !merged).fetchSemanticsNodes().isNotEmpty()
        }
    }

    /**
     * Run the main looper and move its clock on: on Robolectric's paused looper, time stands still unless a test moves
     * it, so the app's delays (search's debounce, read batching, draft saves) would never end, and waitUntil itself
     * doesn't run the looper at all.
     */
    fun pump() {
        org.robolectric.shadows.ShadowLooper.idleMainLooper(PUMP_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        compose.waitForIdle()
    }

    /** Print what is on screen (texts and descriptions), for debugging a test. */
    fun dump(label: String) {
        println("---- $label ----")
        runCatching {
            val r = compose.onAllNodes(androidx.compose.ui.test.isRoot())
            println((0 until r.fetchSemanticsNodes().size).joinToString("\n") { r[it].printToString(Int.MAX_VALUE) }.lines().filter { "Text =" in it || "ContentDescription" in it }.joinToString("\n"))
        }
    }

    /** [block], and what was on screen when it timed out (in the test's output). */
    private fun dumping(block: () -> Unit) {
        try {
            block()
        } catch (e: androidx.compose.ui.test.ComposeTimeoutException) {
            println("---- screen at timeout ----")
            runCatching { println(compose.onAllNodes(androidx.compose.ui.test.isRoot()).let { r -> (0 until r.fetchSemanticsNodes().size).joinToString("\n") { r[it].printToString(Int.MAX_VALUE) } }) }
            throw e
        }
    }

    fun waitFor(text: String, ms: Long = 15_000) = waitFor(hasText(text, substring = true), ms)

    fun waitGone(text: String, ms: Long = 15_000) {
        compose.waitUntil(ms) { pump(); compose.onAllNodes(hasText(text, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    }

    /**
     * Wait for room [name] in the room list and bring its row into view: the test server is shared, so the list holds
     * every test's public rooms, and a lazy list composes only the rows on screen. [shown]: how the row writes it.
     */
    fun showRoom(name: String, shown: String = name) {
        compose.waitUntil(15_000) { pump(); services?.store?.get()?.let { s -> s.roomsStatus == chirkle.android.data.repo.LoadStatus.Ready && s.rooms.values.any { it.name == name } } == true }
        // The list, not another scrolling screen still on its way out (Log in scrolls too).
        compose.waitUntil(15_000) {
            pump()
            val lists = compose.onAllNodes(androidx.compose.ui.test.hasScrollAction())
            (0 until lists.fetchSemanticsNodes().size).any { i -> runCatching { lists[i].performScrollToNode(hasText(shown)) }.isSuccess }
        }
    }

    /**
     * Open room [name] from the list, by its row's click action: scrolled to from below, the row stops at the top edge,
     * under the top bar (the list runs under it), where a tap lands on the bar. Tried again until the room shows (rows
     * move while the shared server's rooms get messages).
     */
    fun openRoom(name: String) = dumping {
        val open = { compose.onAllNodes(hasText("#$name"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.waitUntil(30_000) {
            if (!open()) {
                showRoom(name)
                runCatching { compose.onNode(hasText(name) and androidx.compose.ui.test.hasClickAction()).performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick) }
                repeat(10) { pump() }
            }
            open()
        }
    }

    /**
     * Scroll whichever list holds a node matching [matcher] to it: a lazy list composes only the rows on screen, and the
     * shared server's public rooms push the sections below Rooms (Collections, Hidden) further down with every test.
     */
    fun reveal(matcher: SemanticsMatcher) {
        compose.waitUntil(15_000) {
            pump()
            val lists = compose.onAllNodes(androidx.compose.ui.test.hasScrollAction())
            (0 until lists.fetchSemanticsNodes().size).any { i -> runCatching { lists[i].performScrollToNode(matcher) }.isSuccess }
        }
    }

    /** Wait until the server says so (polling). */
    fun until(ms: Long = 15_000, check: suspend () -> Boolean) = dumping {
        compose.waitUntil(ms) {
            pump()
            kotlinx.coroutines.runBlocking { runCatching { check() }.getOrDefault(false) }
        }
    }

    private companion object {
        const val PUMP_MS = 50L
    }
}
