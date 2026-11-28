package chirkle.android

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import chirkle.android.data.api.NewMessage
import chirkle.android.data.lib.Pages
import chirkle.android.data.lib.newId
import chirkle.android.data.model.Posting
import chirkle.android.data.model.Visibility
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

// The web e2e specs' cases PARITY.md listed as not yet run on the app's screens (2026-11-28): accounts' password change,
// unread's badge and New line, forward's several at once and delete together, dm's close and reopen, hide's unhide,
// room_access's who can post.
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiGapsTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)

    @After fun tearDown() = ui.stop()

    private fun longPress(text: String) {
        ui.waitFor(text)
        // The row's action, not a gesture: a snackbar can sit over the bottom rows.
        compose.onNode(hasText(text, substring = true) and hasClickAction()).performSemanticsAction(SemanticsActions.OnLongClick)
    }

    private fun rowMenu(name: String) =
        compose.onNode(hasText(name) and hasClickAction()).performSemanticsAction(SemanticsActions.OnLongClick)

    @Test fun `change your password on the profile, then log in with the new one (accounts spec)`() {
        val a = newUser()
        ui.signedIn(a)
        ui.waitFor(hasContentDescription("Profile"))
        compose.onNodeWithContentDescription("Profile").performClick()
        ui.waitFor("Your profile")
        val next = "new-pass-${uniq()}"
        compose.onNode(hasSetTextAction() and hasText("Current password")).performScrollTo().performTextInput(TestServer.PASSWORD)
        compose.onNode(hasSetTextAction() and hasText("New password")).performScrollTo().performTextInput(next)
        compose.onNode(hasSetTextAction() and hasText("Confirm new password")).performScrollTo().performTextInput(next)
        compose.onNodeWithText("Change password").performScrollTo().performClick()
        ui.waitFor("Password changed. You were logged out everywhere else.")
        assertTrue(runCatching { runBlocking { TestServer.client().logIn(a.email, next) } }.isSuccess)
        assertTrue(runCatching { runBlocking { TestServer.client().logIn(a.email, TestServer.PASSWORD) } }.isFailure)
    }

    @Test fun `a room with unread shows them in the list, and opens at the first under a New line (unread spec)`() {
        val a = newUser()
        val b = newUser()
        val room = runBlocking { b.api.createRoom("un-${uniq()}") }
        runBlocking { b.api.send(NewMessage(newId(), room.id, "seen before")) }
        ui.signedIn(a)
        ui.showRoom(room.name)
        // Read up to here; then three more come.
        runBlocking { a.api.markRead(room.id, a.api.page(Pages.latest(room.id)).last().created) }
        runBlocking { (1..3).forEach { b.api.send(NewMessage(newId(), room.id, "unread $it")) } }
        ui.waitFor(hasText(room.name) and hasContentDescription("3 unread", substring = true), merged = true)
        ui.openRoom(room.name)
        ui.waitFor("unread 1")
        ui.waitFor(hasContentDescription("New"))
        ui.until { a.api.unreadCounts().rooms[room.id] == null }
    }

    @Test fun `select several messages, forward them together, then delete several of your own (forward spec)`() {
        val a = newUser()
        val from = runBlocking { a.api.createRoom("sel-${uniq()}") }
        val to = runBlocking { a.api.createRoom("selto-${uniq()}") }
        runBlocking { listOf("first pick", "second pick", "third pick").forEach { a.api.send(NewMessage(newId(), from.id, it)) } }
        ui.signedIn(a)
        ui.openRoom(from.name)
        longPress("first pick")
        ui.waitFor("Select")
        compose.onNodeWithText("Select").performClick()
        ui.waitFor("1 selected")
        compose.onNodeWithText("second pick").performClick()
        ui.waitFor("2 selected")
        compose.onNodeWithContentDescription("Forward").performClick()
        ui.waitFor("Forward 2 messages")
        compose.onNodeWithContentDescription("Search rooms and people").performTextInput(to.name)
        ui.waitFor("#${to.name}")
        compose.onNodeWithText("#${to.name}").performClick()
        // Both, each with who first wrote it (the page comes newest first).
        ui.until { a.api.page(Pages.latest(to.id)).filter { it.forwardedFrom == a.user.id }.map { it.text }.sorted() == listOf("first pick", "second pick") }
        // Delete together.
        longPress("second pick")
        ui.waitFor("Select")
        compose.onNodeWithText("Select").performClick()
        ui.waitFor("1 selected")
        // Its click action: the bottom row can sit under the forward's snackbar, which a tap would hit.
        compose.onNode(hasText("third pick", substring = true) and hasClickAction()).performSemanticsAction(SemanticsActions.OnClick)
        ui.waitFor("2 selected")
        compose.onNodeWithContentDescription("Delete").performClick()
        ui.waitFor("Delete these messages?")
        compose.onNodeWithText("Delete").performClick()
        ui.until { a.api.page(Pages.latest(from.id)).filter { it.deleted }.map { it.text.ifEmpty { "x" } }.size == 2 }
        ui.until { a.api.page(Pages.latest(from.id)).single { !it.deleted }.text == "first pick" }
    }

    @Test fun `a closed conversation comes back with a new message (dm spec)`() {
        val a = newUser()
        val b = newUser("dmc-${uniq()}")
        val dm = runBlocking { b.api.openDm(a.user.id).also { b.api.send(NewMessage(newId(), it.id, "hello")) } }
        ui.signedIn(a)
        ui.reveal(hasText(b.user.name))
        rowMenu(b.user.name)
        ui.waitFor("Close conversation")
        compose.onNodeWithText("Close conversation").performClick()
        ui.until { a.api.listHidden().any { it.room == dm.id } }
        ui.until { compose.onAllNodes(hasText(b.user.name) and hasClickAction()).fetchSemanticsNodes().isEmpty() }
        runBlocking { b.api.send(NewMessage(newId(), dm.id, "are you there?")) }
        ui.until { a.api.listHidden().none { it.room == dm.id } }
        ui.reveal(hasText(b.user.name))
    }

    @Test fun `a hidden room is unhidden from Hidden and archived (hide spec)`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("uh-${uniq()}") }
        runBlocking { a.api.hideRoom(room.id) }
        ui.signedIn(a)
        ui.reveal(hasContentDescription("Hidden & archived (", substring = true))
        compose.onNode(hasContentDescription("Hidden & archived (", substring = true)).performSemanticsAction(SemanticsActions.OnClick)
        ui.reveal(hasContentDescription("Actions for #${room.name}"))
        compose.onNodeWithContentDescription("Actions for #${room.name}").performClick()
        compose.onNodeWithText("Unhide").performClick()
        ui.until { a.api.listHidden().none { it.room == room.id } }
        ui.showRoom(room.name)
    }

    @Test fun `only the people chosen post, the others read along and get the composer once chosen (room_access spec)`() {
        val a = newUser()
        val b = newUser()
        val room = runBlocking { a.api.createRoom("wp-${uniq()}").also { a.api.setAccess(it.id, Visibility.Public, emptyList(), Posting.Selected, listOf(a.user.id)) } }
        runBlocking { a.api.send(NewMessage(newId(), room.id, "only I post")) }
        ui.signedIn(b)
        ui.openRoom(room.name)
        ui.waitFor("only I post")
        ui.waitFor("Only some people can post in this room. You can read along and react.")
        assertTrue(compose.onAllNodes(hasContentDescription("Message")).fetchSemanticsNodes().isEmpty())
        runBlocking { a.api.setAccess(room.id, Visibility.Public, emptyList(), Posting.Selected, listOf(a.user.id, b.user.id)) }
        ui.waitFor(hasContentDescription("Message"))
        ui.waitGone("Only some people can post")
    }
}
