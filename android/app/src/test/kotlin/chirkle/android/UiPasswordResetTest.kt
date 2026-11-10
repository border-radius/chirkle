package chirkle.android

import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import chirkle.android.data.testing.TestServer
import chirkle.android.data.testing.TestServer.newUser
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Forgot password (DESIGN.md §39, ANDROID.md §62): offered while the server sends email; asks where to send the link.
// The mail settings point at a closed port: PocketBase answers at once and sends in the background, and nobody reads it.
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiPasswordResetTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)

    private fun mail(on: Boolean) {
        TestServer.admin("PATCH", "/api/settings", """{"smtp":{"enabled":$on,"host":"127.0.0.1","port":1}}""")
    }

    @After fun tearDown() {
        ui.stop()
        mail(false)
    }

    @Test fun `the site says whether reset is offered`() = runBlocking {
        mail(false)
        assertFalse(TestServer.client().site().passwordReset)
        mail(true)
        assertTrue(TestServer.client().site().passwordReset)
        // Answered the same for an address in other capitals and for one nobody has.
        TestServer.client().requestPasswordReset("  ${newUser().email.uppercase()} ")
        TestServer.client().requestPasswordReset("nobody-${TestServer.uniq()}@test.local")
    }

    @Test fun `Forgot password asks for the email (the one typed to log in) and says where the link went`() {
        mail(true)
        ui.start()
        ui.waitFor("Forgot password?")
        compose.onNode(hasSetTextAction() and hasText("Email")).performTextInput("ada@test.local")
        compose.onNodeWithText("Forgot password?").performScrollTo().performClick()
        ui.waitFor("Reset password")
        assertEquals(0, compose.onAllNodes(hasText("Sign up")).fetchSemanticsNodes().size)
        compose.onNode(hasSetTextAction() and hasText("ada@test.local")).assertExists()
        compose.onNodeWithText("Send link").performScrollTo().performClick()
        ui.waitFor("If an account uses ada@test.local, a link to set a new password is on its way")
        compose.onNodeWithText("Back to log in").performScrollTo().performClick()
        ui.waitFor("Sign up")
        compose.onNodeWithText("Forgot password?").assertExists()
    }

    @Test fun `not offered without mail settings`() {
        mail(false)
        ui.start()
        ui.waitFor(hasText("Password"))
        ui.pump()
        assertEquals(0, compose.onAllNodes(hasText("Forgot password?")).fetchSemanticsNodes().size)
    }
}
