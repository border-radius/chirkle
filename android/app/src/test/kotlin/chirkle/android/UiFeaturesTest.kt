package chirkle.android

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.geometry.Offset
import chirkle.android.data.api.NewMessage
import chirkle.android.data.lib.Pages
import chirkle.android.data.lib.newId
import chirkle.android.data.model.Visibility
import chirkle.android.data.testing.TestServer
import chirkle.android.data.testing.TestServer.newUser
import chirkle.android.data.testing.TestServer.uniq
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// The parity scenarios of tests/e2e on the app's screens (android/PARITY.md), on Robolectric against a real PocketBase.
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiFeaturesTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)

    @After fun tearDown() = ui.stop()

    private fun openRoom(name: String) {
        ui.openRoom(name)
        ui.waitFor("Beginning of #$name")
    }

    private fun longPress(text: String) {
        ui.waitFor(text)
        compose.onNodeWithText(text).performTouchInput { longClick() }
    }

    private fun type(text: String) = compose.onNode(hasContentDescription("Message")).performTextInput(text)

    private fun send() = compose.onNodeWithContentDescription("Send").performClick()

    @Test fun `a message sent at the bottom of a full room shows whole, above the composer`() {
        val a = newUser()
        val b = newUser()
        val room = runBlocking { a.api.createRoom("fu-${uniq()}") }
        runBlocking {
            val last = (1..12).map { b.api.send(NewMessage(newId(), room.id, "filler $it")) }.last()
            a.api.markRead(room.id, last.created) // read: the room opens at the bottom, not at the first unread one
        }
        ui.signedIn(a)
        ui.openRoom(room.name)
        ui.waitFor("filler 12")
        type("line one\nline two\nline three\nline four")
        send()
        ui.waitFor("line four")
        repeat(10) { ui.pump() }
        // Before the fix the list kept its old bottom row in place: the new message sat under the composer.
        val sent = compose.onNodeWithText("line four", substring = true).fetchSemanticsNode().boundsInRoot
        val composer = compose.onNode(hasContentDescription("Message")).fetchSemanticsNode().boundsInRoot
        assertTrue("the message ends at ${sent.bottom}, the composer starts at ${composer.top}", sent.bottom <= composer.top)
        assertTrue(compose.onAllNodes(hasContentDescription("Jump to latest", substring = true)).fetchSemanticsNodes().isEmpty())
    }

    @Test fun `replies quote the message (replies spec)`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("rp-${uniq()}") }
        runBlocking { a.api.send(NewMessage(newId(), room.id, "the question")) }
        ui.signedIn(a)
        openRoom(room.name)
        longPress("the question")
        ui.waitFor("Reply")
        compose.onNodeWithText("Reply").performClick()
        ui.waitFor("Replying to ${a.user.name}")
        type("the answer")
        send()
        ui.until { a.api.page(Pages.latest(room.id)).any { it.text == "the answer" && it.replyTo.isNotEmpty() } }
        ui.waitFor(hasContentDescription("Quoting ${a.user.name}: the question", substring = true))
    }

    @Test fun `swiping the room to the right goes back to the rooms, a short swipe stays`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("sb-${uniq()}") }
        runBlocking { a.api.send(NewMessage(newId(), room.id, "swipe me")) }
        ui.signedIn(a)
        openRoom(room.name)
        ui.waitFor("swipe me")
        val messages = compose.onNode(hasContentDescription("Messages"))
        // A short, slow drag springs back: the room stays, and no longer replies to the message.
        messages.performTouchInput { swipe(centerLeft + Offset(width * 0.1f, 0f), center + Offset(-width * 0.25f, 0f), durationMillis = 600) }
        repeat(5) { ui.pump() }
        compose.onNodeWithContentDescription("Back to rooms").assertExists()
        assertTrue(compose.onAllNodes(hasText("Replying to", substring = true)).fetchSemanticsNodes().isEmpty())
        messages.performTouchInput { swipeRight(startX = width * 0.1f, endX = width * 0.9f) }
        ui.waitGone("swipe me")
        ui.showRoom(room.name)
    }

    @Test fun `quotes and the reply bar follow the original's edits and delete (QA BUG-181, BUG-182)`() {
        val a = newUser()
        val b = newUser()
        val room = runBlocking { a.api.createRoom("rf-${uniq()}") }
        val original = runBlocking { b.api.send(NewMessage(newId(), room.id, "the plan")) }
        runBlocking { b.api.send(NewMessage(newId(), room.id, "a reply to it", replyTo = original.id)) }
        ui.signedIn(a)
        openRoom(room.name)
        ui.waitFor("a reply to it")
        compose.onNode(hasText("the plan") and SemanticsMatcher.keyIsDefined(SemanticsActions.OnLongClick)).performTouchInput { longClick() }
        compose.onNodeWithText("Reply").performClick()
        ui.waitFor("Replying to ${b.user.name}")
        runBlocking { b.api.edit(original.id, "the new plan") }
        ui.waitFor(hasContentDescription("Quoting ${b.user.name}: the new plan", substring = true))
        ui.until { compose.onAllNodes(hasText("the plan")).fetchSemanticsNodes().isEmpty() } // in the bar too
        runBlocking { b.api.softDelete(original.id) }
        ui.until { compose.onAllNodes(hasText("Replying to", substring = true)).fetchSemanticsNodes().isEmpty() }
        ui.waitFor(hasContentDescription("Quoting ${b.user.name}: Message deleted", substring = true))
    }

    @Test fun `edits show as edited (edit spec)`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("ed-${uniq()}") }
        runBlocking { a.api.send(NewMessage(newId(), room.id, "frist")) }
        ui.signedIn(a)
        openRoom(room.name)
        longPress("frist")
        compose.onNodeWithText("Edit").performClick()
        ui.waitFor("Edit message")
        compose.onNode(hasContentDescription("Message")).performTextClearance()
        type("first")
        compose.onNodeWithContentDescription("Save").performClick()
        ui.waitFor("(edited)")
        ui.until { a.api.page(Pages.latest(room.id)).single().let { it.text == "first" && it.editedAt.isNotEmpty() } }
    }

    @Test fun `quick reactions count (reactions spec)`() {
        val a = newUser()
        val b = newUser()
        val room = runBlocking { a.api.createRoom("re-${uniq()}") }
        val m = runBlocking { b.api.send(NewMessage(newId(), room.id, "react to me")) }
        ui.signedIn(a)
        openRoom(room.name)
        longPress("react to me")
        compose.onNodeWithContentDescription("React with 👍").performClick()
        ui.waitFor(hasContentDescription("You reacted with 👍"))
        ui.until { a.api.getMessage(m.id).reactions.singleOrNull()?.users == listOf(a.user.id) }
    }

    @Test fun `a message that came while the app was in the background is read once you are back (QA BUG-157)`() {
        val a = newUser()
        val b = newUser()
        val room = runBlocking { a.api.createRoom("bg-${uniq()}") }
        ui.signedIn(a)
        ui.accounts!!.setVisible(true)
        openRoom(room.name)
        ui.accounts!!.setVisible(false)
        val m = runBlocking { b.api.send(NewMessage(newId(), room.id, "while you were away")) }
        ui.waitFor("while you were away") // realtime stays up for a while in the background
        ui.accounts!!.setVisible(true)
        ui.until { (a.api.readPositions(listOf(room.id))[room.id] ?: "") >= m.created }
    }

    @Test fun `a message's menu closes when its author deletes it meanwhile (QA BUG-156)`() {
        val a = newUser()
        val b = newUser()
        val room = runBlocking { a.api.createRoom("md-${uniq()}") }
        val m = runBlocking { b.api.send(NewMessage(newId(), room.id, "soon gone")) }
        ui.signedIn(a)
        openRoom(room.name)
        longPress("soon gone")
        ui.waitFor(hasContentDescription("React with 👍"))
        runBlocking { b.api.softDelete(m.id) }
        ui.waitFor("Message deleted")
        ui.until { compose.onAllNodes(hasContentDescription("React with 👍")).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun `deleting asks first, then shows the message as deleted (edit spec)`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("de-${uniq()}") }
        val m = runBlocking { a.api.send(NewMessage(newId(), room.id, "oops")) }
        ui.signedIn(a)
        openRoom(room.name)
        longPress("oops")
        compose.onNodeWithText("Delete").performClick()
        ui.waitFor("Delete this message?")
        compose.onNodeWithText("Delete").performClick() // the dialog's: the sheet is gone
        ui.waitFor("Message deleted")
        ui.until { a.api.getMessage(m.id).deleted }
    }

    @Test fun `search finds messages and goes to one far back (search spec)`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("se-${uniq()}") }
        runBlocking {
            a.api.send(NewMessage(newId(), room.id, "Needle number one"))
            repeat(60) { a.api.send(NewMessage(newId(), room.id, "filler $it")) }
        }
        ui.signedIn(a)
        ui.showRoom(room.name)
        compose.onNodeWithText(room.name).performClick()
        ui.waitFor("filler 59")
        compose.onNodeWithContentDescription("Search messages").performClick()
        compose.onNode(hasSetTextAction() and hasContentDescription("Search messages")).performTextInput("NEEDLE")
        ui.waitFor("1 message found.")
        compose.onAllNodes(hasText("number one", substring = true))[0].performClick()
        compose.onNodeWithContentDescription("Close search").performClick()
        ui.waitFor("Needle number one")
    }

    @Test fun `a message gone to shows whole, though the messages after it are tall`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("tg-${uniq()}") }
        val tall = (1..30).joinToString("\n") { "line $it" }
        runBlocking {
            a.api.send(NewMessage(newId(), room.id, "Needle here"))
            repeat(2) { a.api.send(NewMessage(newId(), room.id, "tall $it\n$tall")) }
            repeat(40) { a.api.send(NewMessage(newId(), room.id, "filler $it")) }
        }
        ui.signedIn(a)
        ui.showRoom(room.name)
        compose.onNodeWithText(room.name).performClick()
        ui.waitFor("filler 39")
        compose.onNodeWithContentDescription("Search messages").performClick()
        compose.onNode(hasSetTextAction() and hasContentDescription("Search messages")).performTextInput("NEEDLE")
        ui.waitFor("1 message found.")
        compose.onAllNodes(hasText("Needle here"))[0].performClick()
        ui.waitGone("1 message found.")
        repeat(10) { ui.pump() }
        // Before the fix the two rows after it were put at the bottom: taller than the list, they pushed it off the top.
        val target = compose.onNodeWithText("Needle here").fetchSemanticsNode().boundsInRoot
        val list = compose.onNodeWithContentDescription("Messages").fetchSemanticsNode().boundsInRoot
        val composer = compose.onNode(hasContentDescription("Message")).fetchSemanticsNode().boundsInRoot
        assertTrue("the message is at ${target.top}..${target.bottom}, the list ${list.top}..${composer.top}", target.top >= list.top && target.bottom <= composer.top)
    }

    @Test fun `a new DM opens from the people search (dm spec)`() {
        val a = newUser()
        val b = newUser("bo-${uniq()}")
        ui.signedIn(a)
        ui.waitFor("Rooms")
        ui.reveal(hasContentDescription("New direct message"))
        compose.onNodeWithContentDescription("New direct message").performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
        compose.onNode(hasSetTextAction()).performTextInput(b.user.name.take(6))
        ui.waitFor(b.user.name)
        compose.onAllNodes(hasText(b.user.name))[0].performClick()
        ui.waitFor("Beginning of your conversation with ${b.user.name}")
        type("hi bo")
        send()
        ui.until { b.api.listRooms().any { it.isDm && a.user.id in it.members } }
    }

    @Test fun `hiding a room moves it under Hidden (hide spec)`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("hi-${uniq()}") }
        ui.signedIn(a)
        ui.showRoom(room.name)
        // A long press opens the row's menu (no ⋮ in Rooms, QA BUG-196); its action, not a gesture: scrolled to the bottom
        // edge, the row can be cut off.
        compose.onNode(hasText(room.name) and hasClickAction()).performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnLongClick)
        ui.waitFor("Hide")
        compose.onNodeWithText("Hide").performClick()
        ui.reveal(hasContentDescription("Hidden & archived (1)"))
        ui.until { a.api.listHidden().any { it.room == room.id } }
    }

    @Test fun `an archived room is read-only (archive spec)`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("ar-${uniq()}") }
        ui.signedIn(a)
        openRoom(room.name)
        compose.onNodeWithContentDescription("Room actions").performClick()
        compose.onNodeWithText("Archive room").performClick()
        ui.waitFor("It becomes read-only for everyone.")
        compose.onNodeWithText("Archive").performClick() // the dialog's: the menu is gone
        ui.waitFor("This room is archived. History is read-only.")
        ui.until { a.api.getRoom(room.id).archived }
    }

    @Test fun `room access makes a room private with its members (room_access spec)`() {
        val a = newUser()
        val b = newUser("mem-${uniq()}")
        val room = runBlocking { a.api.createRoom("ac-${uniq()}") }
        ui.signedIn(a)
        openRoom(room.name)
        compose.onNodeWithContentDescription("Room actions").performClick()
        compose.onNodeWithText("Room access…").performClick()
        ui.waitFor("Who can see #${room.name}?")
        compose.onNodeWithText("Private").performClick()
        ui.waitFor("Only you and the people you add will see this room.")
        compose.onNodeWithText("+ Add people").performClick()
        compose.onNode(hasSetTextAction()).performTextInput(b.user.name)
        // The result, not the search field (which holds the name typed).
        val result = hasText(b.user.name) and androidx.compose.ui.test.hasClickAction() and !hasSetTextAction()
        ui.waitFor(result, merged = true)
        compose.onNode(result).performClick()
        compose.onNodeWithText("Done").performClick()
        compose.onNodeWithText("Save").performClick()
        ui.until { a.api.getRoom(room.id).let { it.visibility == Visibility.Private && b.user.id in it.members } }
        assertTrue(runBlocking { b.api.listRooms().any { it.id == room.id } })
    }

    @Test fun `renaming yourself is saved (accounts spec)`() {
        val a = newUser()
        ui.signedIn(a)
        ui.waitFor(hasContentDescription("Profile"))
        compose.onNodeWithContentDescription("Profile").performClick()
        ui.waitFor("Your profile")
        val name = "renamed-${uniq()}"
        compose.onNode(hasSetTextAction() and hasText(a.user.name)).performTextClearance()
        compose.onNode(hasSetTextAction() and hasText("Display name")).performTextInput(name)
        compose.onAllNodes(hasText("Save"))[0].performClick()
        ui.waitFor("Saved.")
        ui.until { a.api.usersById(listOf(a.user.id)).single().name == name }
    }

    @Test fun `signing up logs you in (signup spec)`() {
        ui.start()
        ui.waitFor("Just looking? Read the Open Air rooms")
        compose.onNodeWithText("Sign up").performClick()
        val name = "new-${uniq()}"
        compose.onNode(hasSetTextAction() and hasText("Display name")).performTextInput(name)
        compose.onNode(hasSetTextAction() and hasText("Email")).performTextInput("$name@test.local")
        compose.onNode(hasSetTextAction() and hasText("Password")).performTextInput(TestServer.PASSWORD)
        compose.onAllNodes(hasText("Sign up"))[1].performScrollTo().performClick()
        ui.waitFor("Rooms")
        assertEquals(name, ui.services!!.store.get().user?.name)
    }

    @Test fun `messages are forwarded with who first wrote them (forward spec)`() {
        val a = newUser()
        val b = newUser()
        val from = runBlocking { a.api.createRoom("fw-${uniq()}") }
        val to = runBlocking { a.api.createRoom("fwto-${uniq()}") }
        runBlocking { b.api.send(NewMessage(newId(), from.id, "pass it on")) }
        ui.signedIn(a)
        openRoom(from.name)
        longPress("pass it on")
        compose.onNodeWithText("Forward").performClick()
        ui.waitFor("Forward message")
        // The picker lists every room of the shared test server: narrowed, so the target is composed (lazy list).
        compose.onNodeWithContentDescription("Search rooms and people").performTextInput(to.name)
        ui.waitFor("#${to.name}")
        compose.onNodeWithText("#${to.name}").performClick()
        ui.waitFor("Message forwarded.")
        ui.until { a.api.page(Pages.latest(to.id)).singleOrNull()?.forwardedFrom == b.user.id }
    }

    @Test fun `the forward picker searches rooms and finds people with no DM yet (forward spec)`() {
        val a = newUser()
        val b = newUser()
        val from = runBlocking { a.api.createRoom("fs-${uniq()}") }
        val other = runBlocking { a.api.createRoom("fsother-${uniq()}") }
        runBlocking { a.api.send(NewMessage(newId(), from.id, "find them")) }
        ui.signedIn(a)
        openRoom(from.name)
        longPress("find them")
        compose.onNodeWithText("Forward").performClick()
        ui.waitFor("Forward message")
        ui.waitFor("#${other.name}")
        // Rooms narrow as you type; the person comes from the server.
        compose.onNodeWithContentDescription("Search rooms and people").performTextInput(b.user.name.uppercase())
        ui.waitGone("#${other.name}")
        ui.waitFor(b.user.name)
        compose.onNodeWithText(b.user.name).performClick()
        ui.waitFor("Message forwarded.")
        val dm = runBlocking { a.api.listRooms() }.single { it.isDm && b.user.id in it.members }
        ui.until { a.api.page(Pages.latest(dm.id)).singleOrNull()?.forwardedFrom == a.user.id }
    }
}
