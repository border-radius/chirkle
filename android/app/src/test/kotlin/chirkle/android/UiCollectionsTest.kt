package chirkle.android

import androidx.compose.ui.test.performSemanticsAction
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
import chirkle.android.data.api.NewMessage
import chirkle.android.data.lib.newId
import chirkle.android.data.model.SaveFrom
import chirkle.android.data.pb.UploadFile
import chirkle.android.data.testing.TestServer.newUser
import chirkle.android.data.testing.TestServer.uniq
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Media collections (DESIGN.md §31), ported 2026-10-23: the web's collections spec on the app's screens.
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class)
class UiCollectionsTest {
    @get:Rule val compose = createComposeRule()
    private val ui = UiHarness(compose)

    @After fun tearDown() = ui.stop()

    /** A 1×1 PNG. */
    private val png = byteArrayOf(
        -119, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, -60, -119, 0, 0, 0, 13, 73,
        68, 65, 84, 120, -38, 99, -8, -1, -1, 63, 0, 5, -2, 2, -2, -89, 53, -127, -124, 0, 0, 0, 0, 73, 69, 78, 68, -82, 66, 96, -126,
    )

    private fun dot(name: String = "dot.png") = UploadFile(name, "image/png", png.toRequestBody("image/png".toMediaType()))

    /** Bring [text] into view in whichever list holds it, then tap it. */
    private fun tapInList(text: String) {
        ui.reveal(hasText(text))
        ui.waitFor(hasText(text) and hasClickAction(), merged = true)
        compose.onNode(hasText(text) and hasClickAction()).performScrollTo().performClick()
    }

    @Test fun `make a collection from the room list and save a room's image to it`() {
        val a = newUser()
        val room = runBlocking { a.api.createRoom("cu-${uniq()}") }
        runBlocking { a.api.send(NewMessage(newId(), room.id, "a picture", listOf(dot()))) }
        val name = "Keep ${uniq()}"
        ui.signedIn(a)
        ui.showRoom(room.name)
        ui.reveal(hasContentDescription("New collection"))
        compose.onNodeWithContentDescription("New collection").performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
        compose.onNode(hasSetTextAction()).performTextInput(name)
        compose.onNodeWithText("Create").performClick()
        ui.waitFor("Nothing here yet. Upload images and videos")
        compose.onNodeWithContentDescription("Back").performClick()

        ui.showRoom(room.name)
        compose.onNodeWithText(room.name).performClick()
        ui.waitFor("a picture")
        compose.onNodeWithContentDescription("Save dot.png to collection").performClick()
        tapInList(name)
        ui.waitFor("Saved.")
        val coll = ui.services!!.store.get().collections!!.mine.single { it.name == name }.id
        val msg = runBlocking { a.api.page(chirkle.android.data.lib.Pages.latest(room.id)) }.single { it.text == "a picture" }
        ui.until { a.api.savedIn(SaveFrom.File(msg.id, msg.files.single())).keys == setOf(coll) }
        // Its tile shows what is in it (the newest four).
        val item = runBlocking { a.api.savedIn(SaveFrom.File(msg.id, msg.files.single())) }.getValue(coll)
        ui.until { ui.services!!.store.get().collections!!.mine.single { it.id == coll }.preview.map { it.id } == listOf(item) }
    }

    @Test fun `a badge links to a public collection, which another user subscribes to and sees what is new`() {
        val owner = newUser()
        val b = newUser()
        val name = "Pub ${uniq()}"
        val room = runBlocking { owner.api.createRoom("cb-${uniq()}") }
        val coll = runBlocking { owner.api.createCollection(name, true) }
        val item = runBlocking { owner.api.uploadItem(coll, dot("first.png")) }
        runBlocking { owner.api.send(NewMessage(newId(), room.id, "from my collection", items = listOf(item.id))) }
        ui.signedIn(b)
        // In view, as ChirkleApp makes it on a device: what is on screen counts as seen.
        ui.accounts!!.setVisible(true)
        ui.showRoom(room.name)
        compose.onNodeWithText(room.name).performClick()
        ui.waitFor("from my collection")
        ui.waitFor(hasContentDescription("From the collection $name"), merged = true)
        compose.onNode(hasContentDescription("From the collection $name")).performClick()
        ui.waitFor(hasContentDescription("first.png", substring = true))
        compose.onNodeWithText("Subscribe").performClick()
        ui.waitFor("Unsubscribe")
        compose.onNodeWithContentDescription("Back").performClick()
        ui.waitFor(hasContentDescription("Back to rooms"))
        compose.onNodeWithContentDescription("Back to rooms").performClick()

        // Something new: the room list counts it, the page marks it and the count goes.
        runBlocking { owner.api.uploadItem(coll, dot("second.png")) }
        ui.reveal(hasContentDescription("1 new"))
        ui.waitFor(hasContentDescription("1 new"))
        tapInList(name)
        ui.waitFor("1 new since your last visit")
        ui.waitFor(hasContentDescription("second.png, new"))
        ui.until { b.api.collections().subs.single { it.id == coll }.new == 0 }
    }

    @Test fun `attaching from a collection sends the file and says where it came from`() {
        val a = newUser()
        val name = "Att ${uniq()}"
        val room = runBlocking { a.api.createRoom("cp-${uniq()}") }
        val coll = runBlocking { a.api.createCollection(name, false) }
        runBlocking { a.api.uploadItem(coll, dot("pick.png")) }
        ui.signedIn(a)
        ui.showRoom(room.name)
        compose.onNodeWithText(room.name).performClick()
        ui.waitFor("Beginning of #${room.name}")
        ui.until { ui.services!!.store.get().collections?.mine?.any { it.id == coll } == true }
        compose.onNodeWithContentDescription("Attach files").performClick()
        compose.onNodeWithText("From a collection").performClick()
        ui.waitFor(hasContentDescription("pick.png"))
        compose.onNodeWithContentDescription("pick.png").performClick()
        compose.onNodeWithText("Attach 1").performClick()
        ui.waitFor(hasContentDescription("pick.png, from a collection"))
        compose.onNodeWithContentDescription("Send").performClick()
        ui.until {
            a.api.page(chirkle.android.data.lib.Pages.latest(room.id)).any { m -> m.files.size == 1 && m.fileSources.values.toList() == listOf(coll) }
        }
        val m = runBlocking { a.api.page(chirkle.android.data.lib.Pages.latest(room.id)) }.single { it.files.isNotEmpty() }
        assertEquals("pick.png", m.fileNames[m.files.single()])
        // Your own private collection's badge names it, with a lock.
        ui.waitFor(hasContentDescription("From the collection $name, private"), merged = true)
    }

    @Test fun `saving and unsaving from the viewer, opened from a collection's page`() {
        val a = newUser()
        val from = runBlocking { a.api.createCollection("From ${uniq()}", false) }
        val to = "To ${uniq()}"
        val toId = runBlocking { a.api.createCollection(to, false) }
        val item = runBlocking { a.api.uploadItem(from, dot("view.png")) }
        ui.signedIn(a)
        ui.until { ui.services!!.store.get().collections?.mine?.any { it.id == from } == true }
        val name = ui.services!!.store.get().collections!!.mine.single { it.id == from }.name
        tapInList(name)
        ui.waitFor(hasContentDescription("view.png"))
        compose.onNodeWithContentDescription("view.png").performClick()
        ui.waitFor(hasContentDescription("Save to collection"))
        compose.onNodeWithContentDescription("Save to collection").performClick()
        tapInList(to)
        ui.waitFor("Saved.")
        // The file is one (DESIGN.md §37): it is in the collection it was opened from, and now in To.
        ui.until { a.api.savedIn(SaveFrom.Item(item.id)).keys == setOf(from, toId) }
        tapInList(to)
        ui.waitFor("Removed.")
        ui.until { a.api.savedIn(SaveFrom.Item(item.id)).keys == setOf(from) }
    }
}
