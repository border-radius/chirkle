package chirkle.android

import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeRight
import chirkle.android.data.api.NewMessage
import chirkle.android.data.lib.Pages
import chirkle.android.data.lib.newId
import chirkle.android.data.testing.TestServer.newUser
import chirkle.android.data.testing.TestServer.uniq
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Handles, mentions and "Mentions & replies" (DESIGN.md §41, ANDROID.md §60); the web's mentions.spec.ts.
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiMentionsTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)

    @After fun tearDown() = ui.stop()

    @Test fun `typing an at sign offers the room's people, a tap puts their handle in, and the message mentions them`() {
        val a = newUser()
        val b = newUser("mentionee-${uniq()}")
        val room = runBlocking { a.api.createRoom("me-${uniq()}") }
        runBlocking { b.api.send(NewMessage(newId(), room.id, "I was here")) }
        ui.signedIn(a)
        ui.openRoom(room.name)
        val field = compose.onNode(hasContentDescription("Message"))
        field.performTextInput("thanks @${b.user.handle.take(3)}")
        val offered = hasContentDescription("${b.user.name} @${b.user.handle}")
        ui.waitFor(offered)
        compose.onNode(offered).performClick()
        ui.waitFor(hasText("thanks @${b.user.handle} "))
        compose.onNodeWithContentDescription("Send").performClick()
        ui.until { runBlocking { a.api.page(Pages.latest(room.id)) }.any { it.text.startsWith("thanks") && it.mentions == listOf(b.user.id) } }
    }

    @Test fun `a mention marks its room and counts in Mentions and replies, whose list opens the message`() {
        val a = newUser()
        val b = newUser("ada-${uniq()}")
        val room = runBlocking { b.api.createRoom("mm-${uniq()}") }
        val mine = runBlocking { a.api.send(NewMessage(newId(), room.id, "my words")) }
        ui.signedIn(a)
        ui.waitFor("Mentions & replies")
        runBlocking {
            b.api.send(NewMessage(newId(), room.id, "hey @${a.user.handle} look"))
            b.api.send(NewMessage(newId(), room.id, "an answer", replyTo = mine.id))
        }
        // Live: the room's "@" and the inbox's count.
        ui.waitFor(hasContentDescription("Mentions you"))
        ui.waitFor(hasContentDescription("2 new"))

        compose.onNodeWithText("Mentions & replies").performClick()
        ui.waitFor("${b.user.name} replied to you in #${room.name}")
        ui.waitFor("${b.user.name} mentioned you in #${room.name}")
        ui.until { a.api.unreadCounts().inbox == 0 }
        assertEquals(0, ui.services!!.store.get().inbox)
        compose.onNodeWithText("hey @${a.user.handle} look", substring = true).performClick()
        ui.waitFor(hasContentDescription("Messages"))
        // Read to the end: the "@" goes with the count.
        compose.onNodeWithContentDescription("Messages").performScrollToIndex(0)
        ui.until { a.api.unreadCounts().mentions[room.id] == null }
    }

    @Test fun `a mention read in its room is seen in Mentions and replies too (ANDROID md 65)`() {
        val a = newUser()
        val b = newUser("ada-${uniq()}")
        val room = runBlocking { b.api.createRoom("rd-${uniq()}") }
        runBlocking { b.api.send(NewMessage(newId(), room.id, "read here @${a.user.handle}")) }
        ui.signedIn(a)
        ui.waitFor(hasContentDescription("1 new"))
        ui.openRoom(room.name)
        ui.waitFor(hasContentDescription("Messages"))
        compose.onNodeWithContentDescription("Messages").performScrollToIndex(0)
        ui.until { a.api.unreadCounts().inbox == 0 }
        ui.until { ui.services!!.store.get().inbox == 0 }
        val item = runBlocking { a.api.inbox() }.items.single()
        assertEquals(true, item.read)
    }

    @Test fun `a row taken away while Mentions and replies is open goes (QA BUG-254)`() {
        val a = newUser()
        val b = newUser("ada-${uniq()}")
        val room = runBlocking { b.api.createRoom("gone-${uniq()}") }
        val gone = runBlocking {
            b.api.send(NewMessage(newId(), room.id, "stays @${a.user.handle}"))
            b.api.send(NewMessage(newId(), room.id, "goes @${a.user.handle}"))
        }
        ui.signedIn(a)
        ui.waitFor("Mentions & replies")
        compose.onNodeWithText("Mentions & replies").performClick()
        ui.waitFor("goes @${a.user.handle}")
        runBlocking { b.api.edit(gone.id, "goes nowhere") }
        ui.until { compose.onAllNodes(hasText("goes @${a.user.handle}", substring = true)).fetchSemanticsNodes().isEmpty() }
        ui.waitFor("stays @${a.user.handle}")
    }

    @Test fun `swiping Mentions and replies to the right goes back to the rooms`() {
        val a = newUser()
        val b = newUser("ada-${uniq()}")
        val room = runBlocking { b.api.createRoom("sw-${uniq()}") }
        runBlocking { b.api.send(NewMessage(newId(), room.id, "swipe @${a.user.handle}")) }
        ui.signedIn(a)
        ui.waitFor("Mentions & replies")
        compose.onNodeWithText("Mentions & replies").performClick()
        ui.waitFor("swipe @${a.user.handle}")
        compose.onRoot().performTouchInput { swipeRight(startX = width * 0.1f, endX = width * 0.9f) }
        ui.waitGone("swipe @${a.user.handle}")
        ui.waitFor(hasContentDescription("Profile"))
    }

    @Test fun `your handle can be changed on the profile, a taken one says so`() {
        val a = newUser()
        val b = newUser()
        ui.signedIn(a)
        ui.waitFor(hasContentDescription("Profile"))
        compose.onNodeWithContentDescription("Profile").performClick()
        ui.waitFor("People mention you as @${a.user.handle}.")
        val field = compose.onNode(hasSetTextAction() and hasContentDescription("Handle"))
        field.performTextClearance()
        field.performTextInput(b.user.handle)
        compose.onNodeWithContentDescription("Save handle").performScrollTo().performClick()
        ui.waitFor("This handle is taken. Choose another one.")
        val mine = "h_${uniq().takeLast(8)}"
        field.performTextClearance()
        field.performTextInput("@${mine.uppercase()}")
        compose.onNodeWithContentDescription("Save handle").performScrollTo().performClick()
        ui.waitFor("Saved.")
        ui.until { a.api.usersById(listOf(a.user.id)).single().handle == mine }
        assertEquals(mine, ui.services!!.store.get().user?.handle)
    }
}
