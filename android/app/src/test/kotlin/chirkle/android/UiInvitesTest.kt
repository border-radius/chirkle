package chirkle.android

import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import chirkle.android.data.lib.newId
import chirkle.android.data.api.NewMessage
import chirkle.android.data.model.Visibility
import chirkle.android.data.testing.TestServer
import chirkle.android.data.testing.TestServer.newUser
import chirkle.android.data.testing.TestServer.uniq
import chirkle.android.nav.InviteLink
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Invite links (DESIGN.md §44, ANDROID.md §74) on the app's screens: made and revoked on the access screen, opened and
// joined, and a guest who logs in from one comes back to it.
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiInvitesTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)

    @After fun tearDown() = ui.stop()

    @Test fun `the creator makes a link on the access screen, makes it again and revokes it`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("inv-${uniq()}", Visibility.Private) }
        ui.signedIn(a)
        ui.openRoom(room.name)
        compose.onNodeWithContentDescription("Room actions").performClick()
        compose.onNodeWithText("Room access…").performClick()
        ui.waitFor("Anyone with the link who has an account here can join as a member.")
        compose.onNodeWithText("30 days").performScrollTo().performClick()
        compose.onNodeWithText("Create link").performScrollTo().performClick()
        ui.waitFor("The link is ready to share.")
        val made = runBlocking { a.api.invite(room.id) }!!
        ui.waitFor("${TestServer.url}/invite/${made.token}")
        ui.waitFor("nobody has joined by it yet")
        compose.onNodeWithText("New link").performScrollTo().performClick()
        ui.waitFor("A new link is ready. The old one no longer works.")
        ui.until { a.api.invite(room.id)?.token != made.token }
        compose.onNodeWithText("Revoke").performScrollTo().performClick()
        ui.waitFor("The link no longer works.")
        ui.until { a.api.invite(room.id) == null }
        ui.waitFor("Create link")
    }

    @Test fun `an archived room's link can only be revoked (QA BUG-282)`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("inv-${uniq()}", Visibility.Private) }
        val token = runBlocking { a.api.makeInvite(room.id, 7).token }
        runBlocking { a.api.setArchived(room.id, true) }
        ui.signedIn(a)
        ui.waitFor("Rooms")
        // Archived, it is folded away in the room list: opened by its link.
        ui.open(chirkle.android.nav.Room(room.id))
        ui.waitFor("#${room.name}")
        compose.onNodeWithContentDescription("Room actions").performClick()
        compose.onNodeWithText("Room access…").performClick()
        ui.waitFor("The room is archived: its link doesn't work until the room is unarchived.")
        compose.onNodeWithText("Revoke").performScrollTo().assertExists()
        assertEquals(0, compose.onAllNodesWithText("New link").fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithText("Copy link").fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithText("${TestServer.url}/invite/$token").fetchSemanticsNodes().size)
        compose.onNodeWithText("Revoke").performScrollTo().performClick()
        ui.until { a.api.invite(room.id) == null }
        ui.waitFor("The link no longer works.")
        assertEquals(0, compose.onAllNodesWithText("Create link").fetchSemanticsNodes().size)
    }

    @Test fun `someone opens a link, joins and lands in the room`() {
        val a = newUser()
        val b = newUser()
        val room = runBlocking { a.api.createRoom("inv-${uniq()}", Visibility.Private) }
        val token = runBlocking {
            a.api.send(NewMessage(newId(), room.id, "welcome aboard"))
            a.api.makeInvite(room.id, 7).token
        }
        ui.signedIn(b)
        ui.waitFor("Rooms")
        ui.open(InviteLink(token))
        ui.waitFor("Join #${room.name}")
        ui.waitFor("${a.user.name} invited you to this private room. 1 member")
        compose.onNodeWithText("Join the room").performClick()
        ui.waitFor("welcome aboard")
        assertTrue(runBlocking { a.api.listRooms().first { it.id == room.id }.members }.contains(b.user.id))
        // Opened again: they are in already.
        ui.open(InviteLink(token))
        ui.waitFor("You're in this room already.")
    }

    @Test fun `a guest logs in from a link and comes back to it, and a link that stopped working says so`() {
        val a = newUser()
        val b = newUser()
        val room = runBlocking { a.api.createRoom("inv-${uniq()}", Visibility.Private) }
        val token = runBlocking { a.api.makeInvite(room.id, 1).token }
        ui.start()
        ui.waitFor("Log in")
        ui.open(InviteLink(token))
        ui.waitFor("To join, log in or sign up first.")
        compose.onNode(hasText("Log in") and androidx.compose.ui.test.hasClickAction()).performClick()
        ui.waitFor(hasSetTextAction() and hasText("Email"), merged = true)
        compose.onNode(hasSetTextAction() and hasText("Email")).performTextInput(b.email)
        compose.onNode(hasSetTextAction() and hasText("Password")).performTextInput(TestServer.PASSWORD)
        compose.onAllNodes(hasText("Log in"))[1].performScrollTo().performClick()
        ui.waitFor("Join the room")

        runBlocking { a.api.revokeInvite(room.id) }
        compose.onNodeWithText("Join the room").performClick()
        ui.waitFor("This invite link doesn't work")
        assertNull(runBlocking { a.api.invite(room.id) })
        assertEquals(listOf(a.user.id), runBlocking { a.api.listRooms().first { it.id == room.id }.members })
    }
}
