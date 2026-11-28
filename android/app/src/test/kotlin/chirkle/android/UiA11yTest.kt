package chirkle.android

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import chirkle.android.data.api.NewMessage
import chirkle.android.data.lib.newId
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

// The web's a11y.spec.ts (axe on the login, rooms, room and archived room) as the app can check it (ANDROID.md §13's
// "Compose accessibility checks"): on each screen, everything you can tap says what it is (a text or a description,
// as TalkBack reads it) and is at least 48 dp each way to touch. Colour contrast and a TalkBack pass stay by hand.
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiA11yTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)

    @After fun tearDown() = ui.stop()

    /** What on screen fails the checks, one line each; [where] names the screen. */
    private fun problems(where: String): List<String> {
        repeat(10) { ui.pump() }
        val min = with(compose.density) { 48.dp.toPx() } - 0.5f
        val out = mutableListOf<String>()
        fun visit(n: SemanticsNode) {
            val c = n.config
            // Not laid out (off screen in a lazy list, or clipped away): nothing to touch there.
            val placed = !n.boundsInRoot.isEmpty
            if (placed && c.contains(SemanticsActions.OnClick) && c.getOrNull(SemanticsProperties.Disabled) == null && c.getOrNull(SemanticsProperties.InvisibleToUser) == null) {
                val label = (c.getOrNull(SemanticsProperties.ContentDescription).orEmpty() + c.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text })
                    .joinToString(" ").trim()
                val t = n.touchBoundsInRoot.takeUnless { it.isEmpty } ?: n.boundsInRoot
                if (label.isEmpty()) out += "$where: a tappable node with no label at $t"
                if (t.width < min || t.height < min) out += "$where: \"$label\" is ${(t.width / compose.density.density).toInt()}×${(t.height / compose.density.density).toInt()} dp to touch"
            }
            n.children.forEach(::visit)
        }
        compose.onAllNodes(isRoot()).fetchSemanticsNodes().forEach(::visit)
        return out
    }

    private val androidx.compose.ui.test.junit4.ComposeContentTestRule.density get() = androidx.compose.ui.unit.Density(
        androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>().resources.displayMetrics.density,
    )

    private val Int.dp get() = androidx.compose.ui.unit.Dp(this.toFloat())

    @Test fun `the login screen labels what you tap, and makes it big enough`() {
        ui.start()
        ui.waitFor("Just looking? Read the Open Air rooms")
        val found = problems("login")
        assertTrue(found.distinct().joinToString("\n"), found.isEmpty())
    }

    @Test fun `the rooms, room, archived room and profile screens label what you tap, and make it big enough`() {
        val found = mutableListOf<String>()
        val a = newUser()
        val b = newUser()
        val room = runBlocking { a.api.createRoom("ay-${uniq()}") }
        // Private: an archived room is listed for everyone who can see it, and the suite shares one server.
        val archived = runBlocking { a.api.createRoom("ayar-${uniq()}", chirkle.android.data.model.Visibility.Private) }
        runBlocking {
            b.api.send(NewMessage(newId(), room.id, "something to read"))
            a.api.send(NewMessage(newId(), archived.id, "old news"))
            a.api.setArchived(archived.id, true)
        }
        ui.signedIn(a)
        ui.showRoom(room.name)
        found += problems("rooms")
        ui.openRoom(room.name)
        ui.waitFor("something to read")
        found += problems("room")
        compose.onNodeWithContentDescription("Back to rooms").performClick()
        // Archived rooms are under the folded Hidden & archived.
        ui.reveal(hasContentDescription("Hidden & archived (", substring = true))
        compose.onNode(hasContentDescription("Hidden & archived (", substring = true)).performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
        ui.openRoom(archived.name)
        ui.waitFor("This room is archived. History is read-only.")
        found += problems("archived room")
        compose.onNodeWithContentDescription("Back to rooms").performClick()
        ui.waitFor(hasContentDescription("Profile"))
        compose.onNodeWithContentDescription("Profile").performClick()
        ui.waitFor("Your profile")
        found += problems("profile")
        assertTrue(found.distinct().joinToString("\n"), found.isEmpty())
    }
}
