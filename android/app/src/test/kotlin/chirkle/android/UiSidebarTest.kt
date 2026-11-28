package chirkle.android

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.semantics.SemanticsActions
import chirkle.android.data.api.NewMessage
import chirkle.android.data.lib.newId
import chirkle.android.data.testing.TestServer.newUser
import chirkle.android.data.testing.TestServer.uniq
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// The web's sidebar improvements (2026-11-23) and creation cards (2026-11-24) as the app has them (ANDROID.md §99):
// tests/component/views/rooms.test.ts.
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiSidebarTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)

    @After fun tearDown() = ui.stop()

    @Test fun `a room's unread is a dot with its count read out, a DM's a number`() {
        val a = newUser()
        val b = newUser()
        val room = runBlocking { b.api.createRoom("dot-${uniq()}") }
        ui.signedIn(a)
        ui.showRoom(room.name)
        runBlocking {
            b.api.send(NewMessage(newId(), room.id, "not for you"))
            val dm = b.api.openDm(a.user.id)
            b.api.send(NewMessage(newId(), dm.id, "for you"))
        }
        // The room: no number on screen, "1 unread" said.
        ui.waitFor(hasText(room.name) and hasContentDescription("1 unread", substring = true), merged = true)
        ui.waitFor(hasText(room.name) and hasContentDescription("1 unread", substring = true) and !hasText("1"), merged = true)
        // The DM: its number.
        ui.reveal(hasText(b.user.name))
        ui.waitFor(hasText(b.user.name) and hasText("1"), merged = true)
    }

    @Test fun `New room says a name is taken as it is typed, ignoring case and a leading hash`() {
        val a = newUser()
        val taken = runBlocking { a.api.createRoom("taken-${uniq()}") }
        ui.signedIn(a)
        ui.showRoom(taken.name)
        ui.reveal(hasContentDescription("New room"))
        compose.onNodeWithContentDescription("New room").performSemanticsAction(SemanticsActions.OnClick)
        val field = compose.onNode(hasSetTextAction())
        field.performTextInput("#${taken.name.uppercase()}")
        ui.waitFor("#${taken.name} already exists. Pick another name.")
        compose.onNodeWithText("Create").assertIsNotEnabled()
        field.performTextClearance()
        field.performTextInput("${taken.name}-2")
        ui.waitGone("already exists")
        compose.onNodeWithText("Create").assertIsEnabled()
    }

    @Test fun `a new collection is public unless chosen otherwise, and a name of yours is said taken`() {
        val a = newUser()
        val mine = "Moodboard ${uniq()}"
        runBlocking { a.api.createCollection(mine, false) }
        ui.signedIn(a)
        ui.until { ui.services!!.store.get().collections?.mine?.any { it.name == mine } == true }
        ui.reveal(hasContentDescription("New collection"))
        compose.onNodeWithContentDescription("New collection").performSemanticsAction(SemanticsActions.OnClick)
        val field = compose.onNode(hasSetTextAction())
        field.performTextInput(mine.lowercase())
        ui.waitFor("A collection called $mine already exists.")
        compose.onNodeWithText("Create").assertIsNotEnabled()
        field.performTextClearance()
        val name = "Open ${uniq()}"
        field.performTextInput(name)
        ui.waitFor("Anyone can see it and subscribe.")
        compose.onNodeWithText("Create").performClick()
        ui.until { a.api.collections().mine.single { it.name == name }.public }
    }

    @Test fun `New message shows each person's handle, and says when no one is found`() {
        val a = newUser()
        val b = newUser("findme-${uniq()}")
        ui.signedIn(a)
        ui.reveal(hasContentDescription("New direct message"))
        compose.onNodeWithContentDescription("New direct message").performSemanticsAction(SemanticsActions.OnClick)
        val field = compose.onNode(hasSetTextAction())
        field.performTextInput(b.user.name)
        ui.waitFor("@${b.user.handle}")
        field.performTextClearance()
        val q = "nobody-${uniq()}"
        field.performTextInput(q)
        ui.waitFor("No one found for “$q”")
        ui.waitFor("Check the spelling or try their @handle.")
    }
}
