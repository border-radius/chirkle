package chirkle.android

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.swipe
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.geometry.Offset
import org.junit.Assert.assertTrue
import chirkle.android.data.lib.serverLabel
import chirkle.android.data.testing.TestServer
import chirkle.android.data.testing.TestServer.newUser
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Several servers and accounts on the screens (ANDROID.md §17). "Another server" is the test server by another address
// (localhost for 127.0.0.1): to the app, two servers.
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiAccountsTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)
    private val other = TestServer.url.replace("127.0.0.1", "localhost")

    @After fun tearDown() = ui.stop()

    private fun profile() {
        ui.waitFor(hasContentDescription("Profile"))
        compose.onNodeWithContentDescription("Profile").performClick()
        ui.waitFor("Your profile")
    }

    /** Your accounts: the brand at the top of the room list. */
    private fun accountList() {
        val brand = SemanticsMatcher("opens Accounts") { it.config.getOrNull(SemanticsActions.OnClick)?.label == "Accounts" }
        ui.waitFor(brand, merged = true)
        compose.onNode(brand).performClick()
        ui.waitFor("Add account")
    }

    private fun logIn(u: TestServer.TestUser) {
        compose.onNode(hasSetTextAction() and hasText("Email")).performTextInput(u.email)
        compose.onNode(hasSetTextAction() and hasText("Password")).performTextInput(TestServer.PASSWORD)
        compose.onAllNodes(hasText("Log in"))[1].performScrollTo().performClick()
    }

    @Test fun `add an account on another server, then switch back from the brand's account list`() {
        val u = newUser()
        val v = newUser()
        ui.signedIn(u)
        accountList()
        compose.onNodeWithText("Add account").performScrollTo().performClick()
        ui.waitFor("Choose your server")
        compose.onNode(hasSetTextAction() and hasText("Server address")).performTextInput(other)
        compose.onNodeWithText("Continue").performClick()
        ui.waitFor("on ${serverLabel(other)}")
        logIn(v)
        ui.until { ui.services?.store?.get()?.user?.id == v.user.id }
        assertEquals(other, ui.services!!.server)
        ui.waitFor(serverLabel(other)) // under the rooms title: there are two accounts now

        accountList()
        ui.waitFor(hasText(u.user.name) and hasClickAction(), merged = true)
        compose.onNode(hasText(u.user.name) and hasClickAction()).performScrollTo().performClick()
        ui.until { ui.services?.store?.get()?.user?.id == u.user.id }
        assertEquals(TestServer.url, ui.services!!.server)
        assertEquals(2, ui.accounts!!.list.value.size)
    }

    @Test fun `an address that isn't a chat server says so`() {
        ui.start()
        ui.waitFor("Just looking? Read the Open Air rooms")
        compose.onNodeWithText("Change server").performClick()
        ui.waitFor("Choose your server")
        compose.onNode(hasSetTextAction() and hasText("Server address")).performTextInput("http://127.0.0.1:1")
        compose.onNodeWithText("Continue").performClick()
        ui.waitFor("Can't reach that server")
        compose.onNodeWithText("Cancel").performClick()
        ui.waitFor("Just looking? Read the Open Air rooms")
        assertEquals(TestServer.url, ui.services!!.server)
    }

    @Test fun `swiping the room list to the right opens your accounts, a short swipe stays, left goes back (ANDROID §44, §52)`() {
        val u = newUser()
        ui.signedIn(u)
        ui.waitFor(hasContentDescription("Profile"))
        // A short, slow drag springs back.
        compose.onRoot().performTouchInput { swipe(center - Offset(width * 0.2f, 0f), center, durationMillis = 600) }
        repeat(5) { ui.pump() }
        assertTrue(compose.onAllNodes(hasText("Add account")).fetchSemanticsNodes().isEmpty())
        compose.onNodeWithContentDescription("Profile").assertExists()
        // The old way, to the left, does nothing.
        compose.onRoot().performTouchInput { swipeLeft(startX = width * 0.9f, endX = width * 0.1f) }
        repeat(5) { ui.pump() }
        assertTrue(compose.onAllNodes(hasText("Add account")).fetchSemanticsNodes().isEmpty())
        compose.onRoot().performTouchInput { swipeRight(startX = width * 0.1f, endX = width * 0.9f) }
        ui.waitFor("Add account")
        // And back, the other way.
        compose.onRoot().performTouchInput { swipeLeft(startX = width * 0.9f, endX = width * 0.1f) }
        ui.waitGone("Add account")
        ui.waitFor(hasContentDescription("Profile"))
    }

    @Test fun `logging out leaves your other accounts a tap away`() {
        val u = newUser()
        val v = newUser()
        ui.startWith(listOf(TestServer.url to u.api.pb.authStore.session.value, other to v.api.pb.authStore.session.value))
        profile()
        compose.onNodeWithText("Log out").performScrollTo().performClick()
        ui.waitFor("Your other accounts")
        ui.waitFor(hasText(v.user.name) and hasClickAction(), merged = true)
        compose.onNode(hasText(v.user.name) and hasClickAction()).performScrollTo().performClick()
        ui.until { ui.services?.store?.get()?.user?.id == v.user.id }
        assertEquals(other, ui.services!!.server)
        // The account logged out of was a guest's on its server, and leaving it forgot it.
        assertEquals(listOf(other), ui.accounts!!.list.value.map { it.server })
    }

    @Test fun `switching accounts while requests are in flight doesn't crash the app`() {
        // A request cancelled by the switch came back as an ApiError, uncaught in the cancelled scope: a crash.
        val errors = java.util.Collections.synchronizedList(mutableListOf<Throwable>())
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { _, e -> errors += e }
        try {
            val u = newUser()
            val v = newUser()
            ui.startWith(listOf(TestServer.url to u.api.pb.authStore.session.value, other to v.api.pb.authStore.session.value))
            val a = ui.accounts!!
            val ids = a.list.value.map { it.id }
            repeat(6) { i ->
                a.scope.launch { a.switchTo(ids[(i + 1) % 2]) }
                repeat(i % 3) { ui.pump() }
            }
            // A new account left before logging in is forgotten: its database closes under whatever was running.
            repeat(3) { i ->
                a.scope.launch { a.add(TestServer.url) }
                repeat(i) { ui.pump() }
                a.scope.launch { a.switchTo(ids[0]) }
                repeat(5) { ui.pump() }
            }
            ui.until { ui.services?.store?.get()?.user?.id == u.user.id }
            repeat(20) { ui.pump() }
            assertEquals(emptyList<Throwable>(), errors.toList())
            assertEquals(2, a.list.value.size)
        } finally {
            Thread.setDefaultUncaughtExceptionHandler(prev)
        }
    }
}
