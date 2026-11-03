package chirkle.android

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import chirkle.android.data.api.NewMessage
import chirkle.android.data.lib.newId
import chirkle.android.data.testing.TestServer
import chirkle.android.data.testing.TestServer.newUser
import chirkle.android.data.testing.TestServer.uniq
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Moderators (DESIGN.md §36, ANDROID.md §45): ticked by a superuser; in someone else's room they archive it, change its
// access, delete messages and ban their authors.
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiModeratorsTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)

    @After fun tearDown() = ui.stop()

    /** A new user a superuser made a moderator, its session refreshed to say so. */
    private fun newModerator(): TestServer.TestUser {
        val m = newUser("mod-${uniq()}")
        TestServer.admin("PATCH", "/api/collections/users/records/${m.user.id}", """{"moderator":true}""")
        val user = runBlocking { m.api.refreshAuth() }
        assertTrue(user.moderator)
        return TestServer.TestUser(m.api, user, m.email)
    }

    private fun longPress(text: String) {
        ui.waitFor(text)
        compose.onNode(hasText(text) and SemanticsMatcher.keyIsDefined(SemanticsActions.OnLongClick)).performTouchInput { longClick() }
    }

    @Test fun `a moderator archives someone else's room and sees its access`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("mo-${uniq()}") }
        val m = newModerator()
        ui.signedIn(m)
        ui.openRoom(room.name)
        ui.waitFor("Beginning of #${room.name}")
        compose.onNodeWithContentDescription("Room actions").performClick()
        ui.waitFor("Room access…")
        compose.onNodeWithText("Archive room").performClick()
        compose.onNodeWithText("Archive").performClick()
        ui.waitFor("This room is archived. History is read-only.")
        ui.until { a.api.getRoom(room.id).archived }
    }

    @Test fun `a moderator deletes someone else's message and bans them`() {
        val a = newUser("au-${uniq()}")
        val room = runBlocking { a.api.createRoom("mb-${uniq()}") }
        val msg = runBlocking { a.api.send(NewMessage(newId(), room.id, "buy cheap pills")) }
        val m = newModerator()
        ui.signedIn(m)
        ui.openRoom(room.name)
        longPress("buy cheap pills")
        ui.waitFor("Ban ${a.user.name}")
        compose.onNodeWithText("Delete").performClick()
        compose.onNodeWithText("Delete").performClick() // the dialog's
        ui.until { m.api.getMessage(msg.id).deleted }

        val other = runBlocking { a.api.send(NewMessage(newId(), room.id, "more pills")) }
        longPress(other.text)
        ui.waitFor("Ban ${a.user.name}")
        compose.onNodeWithText("Ban ${a.user.name}").performClick()
        ui.waitFor("sign in until unbanned")
        compose.onNodeWithText("Ban").performClick()
        ui.until { m.api.isBanned(a.user.id) }
        ui.waitFor("Banned. They can't sign in until unbanned.")
        // The snackbar covers the newest message: gone first.
        compose.waitUntil(15_000) { compose.onAllNodes(hasText("Banned.", substring = true)).fetchSemanticsNodes().isEmpty() }
        longPress(other.text)
        ui.waitFor("Unban ${a.user.name}")
        compose.onNodeWithText("Unban ${a.user.name}").performClick()
        ui.until { !m.api.isBanned(a.user.id) }
    }

    @Test fun `QA - the access screen names someone else's room's creator and who keeps a private room`() {
        val a = newUser("cr-${uniq()}")
        val room = runBlocking { a.api.createRoom("mc-${uniq()}") }
        val m = newModerator()
        ui.signedIn(m)
        ui.openRoom(room.name)
        ui.waitFor("Beginning of #${room.name}")
        compose.onNodeWithContentDescription("Room actions").performClick()
        compose.onNodeWithText("Room access…").performClick()
        ui.waitFor("Who can see #${room.name}?")
        compose.onNodeWithText("Private").performClick()
        ui.waitFor("Only its creator and the people added will see this room.")
        ui.waitFor(a.user.name)
        assertTrue(compose.onAllNodes(hasText("Unknown")).fetchSemanticsNodes().isEmpty())
    }

    @Test fun `QA - a banned user's open app is signed out`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("mx-${uniq()}") }
        val m = newModerator()
        ui.signedIn(a)
        ui.openRoom(room.name)
        ui.waitFor("Beginning of #${room.name}")
        runBlocking { m.api.setBanned(a.user.id, true) }
        ui.waitFor("Log in", ms = 30_000)
    }

    @Test fun `others get no Ban and no Delete on someone else's message`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("mn-${uniq()}") }
        runBlocking { a.api.send(NewMessage(newId(), room.id, "just a message")) }
        val b = newUser()
        ui.signedIn(b)
        ui.openRoom(room.name)
        longPress("just a message")
        ui.waitFor("Copy text")
        assertTrue(compose.onAllNodes(hasText("Delete")).fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodes(hasText("Ban", substring = true)).fetchSemanticsNodes().isEmpty())
    }
}
