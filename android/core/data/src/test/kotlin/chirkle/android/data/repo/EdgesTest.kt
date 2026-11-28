package chirkle.android.data.repo

import chirkle.android.data.api.NewMessage
import chirkle.android.data.lib.PageKind
import chirkle.android.data.lib.Side
import chirkle.android.data.lib.newId
import chirkle.android.data.testing.TestServer.newUser
import chirkle.android.data.testing.TestServer.uniq
import chirkle.android.data.testing.closeServices
import chirkle.android.data.testing.eventually
import chirkle.android.data.testing.services
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The web's reconnect.spec.ts and history.spec.ts at the room controller: what realtime missed while it was down
// appears in order once it is back; the history pages back to the first message and returns to live.
@RunWith(RobolectricTestRunner::class)
class EdgesTest {
    @After fun tearDown() = closeServices()

    @Test fun `after a dropped connection, everything missed appears in order once it reconnects (reconnect spec)`() = runBlocking {
        val a = newUser()
        val b = newUser()
        val room = a.api.createRoom("rc-${uniq()}")
        b.api.send(NewMessage(newId(), room.id, "before"))
        val s = services(a)
        val c = s.openRoom(room.id)
        eventually(what = "ready") { c.state.value.phase == Phase.Ready && c.state.value.items.any { it.text == "before" } }
        a.api.pb.realtime.pause()
        eventually(what = "down") { !a.api.pb.realtime.isConnected }
        val missed = (1..5).map { "missed $it" }
        for (t in missed) b.api.send(NewMessage(newId(), room.id, t))
        a.api.pb.realtime.resume()
        eventually(what = "gap filled") { c.state.value.items.map { it.text }.containsAll(missed) }
        assertEquals(listOf("before") + missed, c.state.value.items.map { it.text })
        // And live again after it.
        b.api.send(NewMessage(newId(), room.id, "after"))
        eventually(what = "live") { c.state.value.items.lastOrNull()?.text == "after" }
        c.close()
    }

    @Test fun `scrolls back through the history to the first message, then returns to live (history spec)`() = runBlocking {
        val a = newUser()
        val room = a.api.createRoom("hs-${uniq()}")
        val sent = (1..260).map { a.api.send(NewMessage(newId(), room.id, "h$it")) }
        val s = services(a)
        val c = s.openRoom(room.id)
        eventually(what = "ready") { c.state.value.phase == Phase.Ready }
        // The list nearing its top asks for the edge, again and again, as RoomScreen does.
        eventually(ms = 60_000, what = "the first message") {
            if (c.state.value.hasOlder) c.loadEdge(Side.Top)
            !c.state.value.hasOlder && c.state.value.items.firstOrNull()?.id == sent.first().id
        }
        // Back to live: the latest page, in order.
        c.jump(PageKind.Latest)
        eventually(what = "latest") { c.state.value.items.lastOrNull()?.id == sent.last().id && !c.state.value.hasNewer }
        val texts = c.state.value.items.map { it.text }
        assertEquals("in order", texts, texts.sortedBy { it.drop(1).toInt() })
        assertFalse(c.state.value.hasNewer)
        c.close()
    }
}
