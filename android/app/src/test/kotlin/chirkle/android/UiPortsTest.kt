package chirkle.android

import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performKeyPress
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextInput
import chirkle.android.data.api.NewMessage
import chirkle.android.data.lib.newId
import chirkle.android.data.pb.UploadFile
import chirkle.android.data.repo.ThemeChoice
import chirkle.android.data.testing.TestServer.newUser
import chirkle.android.data.testing.TestServer.uniq
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Web features ported after the app was unfrozen (2026-10-23): Jump to (§32), the media grid (§30), Appearance (§7.8).
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiPortsTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)

    @After fun tearDown() = ui.stop()

    /** A 1×1 PNG. */
    private val png = byteArrayOf(
        -119, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, -60, -119, 0, 0, 0, 13, 73,
        68, 65, 84, 120, -38, 99, -8, -1, -1, 63, 0, 5, -2, 2, -2, -89, 53, -127, -124, 0, 0, 0, 0, 73, 69, 78, 68, -82, 66, 96, -126,
    )

    @Test fun `Inter draws people's text as typed, without contextual alternates (QA BUG-191)`() {
        // With them, "32x1n" showed as "32×1n" and "->" as an arrow, in names, messages and the composer.
        val styles = mutableListOf<androidx.compose.ui.text.TextStyle>()
        compose.setContent {
            chirkle.android.ui.ChirkleTheme {
                val t = androidx.compose.material3.MaterialTheme.typography
                styles += listOf(t.displayLarge, t.headlineSmall, t.titleLarge, t.titleSmall, t.bodyLarge, t.bodyMedium, t.bodySmall, t.labelLarge, t.labelSmall)
            }
        }
        compose.waitForIdle()
        assertTrue(styles.isNotEmpty())
        for (style in styles) assertEquals(chirkle.android.ui.NO_CALT, style.fontFeatureSettings)
    }

    @Test fun `opening a room with unread messages reads only what is on screen, scrolling down reads the rest (§18 3)`() {
        val alice = newUser()
        val bob = newUser()
        val room = runBlocking { alice.api.createRoom("reads-${uniq()}") }
        runBlocking { for (i in 1..30) alice.api.send(NewMessage(newId(), room.id, "unread $i")) }
        ui.signedIn(bob)
        ui.accounts!!.setVisible(true) // away, nothing is read
        ui.showRoom(room.name)
        compose.onNodeWithText(room.name).performClick()
        ui.waitFor("unread 1")
        val unread = suspend { bob.api.unreadCounts().rooms[room.id] ?: 0 }
        // Before, the list was read while it still showed its newest rows, before it went to the first unread one.
        ui.until { unread() in 1..29 }
        repeat(30) { ui.pump() } // longer than the read batching: nothing more is read
        assertTrue(runBlocking { unread() } in 1..29)
        compose.onNodeWithContentDescription("Messages").performScrollToIndex(0)
        ui.until { unread() == 0 }
    }

        @Test fun `jump to finds a room by a word of its name (switcher spec)`() {
        val a = newUser()
        val tag = uniq()
        val room = runBlocking { a.api.createRoom("jump-$tag-target") }
        ui.signedIn(a)
        ui.showRoom(room.name)
        compose.onNodeWithContentDescription("Jump to a room or person").performClick()
        compose.onNode(hasSetTextAction() and hasContentDescription("Jump to")).performTextInput("#$tag")
        ui.waitFor(room.name)
        // Its click action, not a tap: scrolled to the bottom edge, the row can be under the New button.
        compose.onNodeWithText(room.name).performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
        ui.waitFor("Beginning of #${room.name}")
    }

    @Test fun `holding Ctrl+K doesn't open and close Jump to on every repeat (QA BUG-159)`() {
        val a = newUser()
        ui.signedIn(a)
        ui.waitFor(hasContentDescription("Jump to a room or person"))
        compose.onNodeWithContentDescription("Jump to a room or person").performClick()
        val field = hasSetTextAction() and hasContentDescription("Jump to")
        ui.waitFor(field)
        fun ctrlK(repeat: Int) = compose.onNode(field).performKeyPress(
            androidx.compose.ui.input.key.KeyEvent(
                android.view.KeyEvent(0, 0, android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_K, repeat, android.view.KeyEvent.META_CTRL_ON or android.view.KeyEvent.META_CTRL_LEFT_ON),
            ),
        )
        ctrlK(repeat = 1)
        ui.pump()
        ui.waitFor(field) // still open
        ctrlK(repeat = 0)
        ui.until { compose.onAllNodes(field).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun `the media grid shows a room's images and opens the viewer (media spec)`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("md-${uniq()}") }
        runBlocking { a.api.send(NewMessage(newId(), room.id, "a picture", listOf(UploadFile("dot.png", "image/png", png.toRequestBody("image/png".toMediaType()))))) }
        ui.signedIn(a)
        ui.showRoom(room.name)
        // Its click action, not a tap: scrolled to the bottom edge, the row can be under the New button.
        compose.onNodeWithText(room.name).performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
        ui.waitFor("a picture")
        compose.onNodeWithContentDescription("Media").performClick()
        ui.waitFor(hasContentDescription("dot.png", substring = true))
        compose.onNode(hasContentDescription("dot.png", substring = true)).performClick()
        ui.waitFor(hasContentDescription("Download"))
    }

    @Test fun `the viewer drops a message deleted meanwhile, and closes with none left (QA BUG-155)`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("vd-${uniq()}") }
        fun send(name: String) = runBlocking {
            a.api.send(NewMessage(newId(), room.id, "pic $name", listOf(UploadFile(name, "image/png", png.toRequestBody("image/png".toMediaType())))))
        }
        val first = send("one.png")
        val second = send("two.png")
        ui.signedIn(a)
        ui.showRoom(room.name)
        // Its click action, not a tap: scrolled to the bottom edge, the row can be under the New button.
        compose.onNodeWithText(room.name).performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
        ui.waitFor("pic two.png")
        compose.onNodeWithContentDescription("Media").performClick()
        ui.waitFor(hasContentDescription("two.png", substring = true))
        compose.onNode(hasContentDescription("two.png", substring = true)).performClick()
        ui.waitFor("2 of 2")
        runBlocking { a.api.softDelete(second.id) }
        ui.waitGone("of 2")
        // The one before shows instead.
        ui.waitFor("· one.png")
        ui.waitFor(hasContentDescription("Download"))
        runBlocking { a.api.softDelete(first.id) }
        ui.until { compose.onAllNodes(hasContentDescription("Download")).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun `an empty room's media grid says so`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("me-${uniq()}") }
        ui.signedIn(a)
        ui.showRoom(room.name)
        // Its click action, not a tap: scrolled to the bottom edge, the row can be under the New button.
        compose.onNodeWithText(room.name).performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
        ui.waitFor("Beginning of #${room.name}")
        compose.onNodeWithContentDescription("Media").performClick()
        ui.waitFor("No photos or videos here yet.")
    }

    @Test fun `the appearance can be set to dark and is kept (theme spec)`() {
        val a = newUser()
        val services = ui.signedIn(a)
        ui.waitFor(hasContentDescription("Profile"))
        compose.onNodeWithContentDescription("Profile").performClick()
        ui.waitFor("Appearance")
        compose.onNodeWithText("Dark").performScrollTo().performClick()
        ui.until { services.settings.theme.value == ThemeChoice.Dark }
        assertEquals(ThemeChoice.Dark, services.settings.theme.value)
    }

    @Test fun `text shared into the app goes to the chosen room, and the picker stays closed`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("sh-${uniq()}") }
        chirkle.android.nav.ShareInbox.pending = chirkle.android.nav.Shared("shared text", emptyList())
        try {
            ui.signedIn(a)
            ui.waitFor("Share to")
            ui.showRoom(room.name, "#${room.name}")
            compose.onNodeWithText("#${room.name}").performClick()
            ui.waitFor("Beginning of #${room.name}")
            ui.waitFor("shared text")
            ui.waitGone("Share to")
        } finally {
            chirkle.android.nav.ShareInbox.pending = null
        }
    }

    @Test fun `unread rooms are listed first, and a folded section lists only them`() {
        val a = newUser()
        val b = newUser()
        // By name, both would be at the end of the shared server's long list.
        val quiet = runBlocking { a.api.createRoom("zz-quiet-${uniq()}") }
        val busy = runBlocking { a.api.createRoom("zz-busy-${uniq()}") }
        val services = ui.signedIn(b)
        ui.until { services.store.get().let { it.counted && quiet.id in it.rooms && busy.id in it.rooms } }
        runBlocking { a.api.send(NewMessage(newId(), busy.id, "hello")) }
        ui.until { services.store.get().unread[busy.id] == 1 }
        // At the top, without scrolling.
        ui.waitFor(hasText(busy.name))
        val list = compose.onNode(hasScrollAction())
        compose.onNode(hasText("Rooms") and hasClickAction(), useUnmergedTree = false).performClick()
        ui.until { "rooms" in services.settings.folded.value }
        ui.pump()
        assertTrue(runCatching { list.performScrollToNode(hasText(quiet.name)) }.isFailure)
        list.performScrollToNode(hasText(busy.name))
        compose.onNode(hasText("Rooms") and hasClickAction()).performScrollTo().performClick()
        ui.until { "rooms" !in services.settings.folded.value }
        ui.showRoom(quiet.name)
    }
}
