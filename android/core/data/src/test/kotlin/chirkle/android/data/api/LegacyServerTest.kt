package chirkle.android.data.api

import chirkle.android.data.lib.Pages
import chirkle.android.data.lib.newId
import chirkle.android.data.lib.searchQuery
import chirkle.android.data.model.Cursor
import chirkle.android.data.pb.MemoryAuthStore
import chirkle.android.data.pb.PbClient
import chirkle.android.data.pb.UploadFile
import chirkle.android.data.testing.TestServer
import chirkle.android.data.testing.TestServer.uniq
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections

/**
 * The app with a server from before the list routes (docs/API.md): the room list, every kind of page, the changes,
 * search and the notification check fall back to the records API and give what the routes give on a current server.
 * `TestServer.legacyUrl` is this repository's hooks without the routes, or an old release's (-Pchirkle.legacyHooks=…).
 */
class LegacyServerTest {
    /** A 1×1 PNG. */
    private val png = byteArrayOf(
        -119, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, -60, -119, 0, 0, 0, 13, 73,
        68, 65, 84, 120, -38, 99, -8, -1, -1, 63, 0, 5, -2, 2, -2, -89, 53, -127, -124, 0, 0, 0, 0, 73, 69, 78, 68, -82, 66, 96, -126,
    )

    /** A client of the server at [at] that notes each request's path and answer code. */
    private class Recorded(at: String) {
        val calls: MutableList<String> = Collections.synchronizedList(mutableListOf())
        private val http = TestServer.http.newBuilder().addInterceptor { chain ->
            chain.proceed(chain.request()).also { calls += "${it.code} ${chain.request().method} ${chain.request().url.encodedPath}" }
        }.build()
        val api = ChirkleApi(PbClient(at, http, MemoryAuthStore()))
    }

    /** The same session on [at]: what the app sees, as message texts (ids differ between the servers). */
    private fun scenario(at: String): Pair<List<Any>, List<String>> = runBlocking {
        val me = Recorded(at)
        val name = "legacy-${uniq()}"
        me.api.signUp("$name@test.local", TestServer.PASSWORD, name)
        val bob = TestServer.newUser(at = at)
        val room = me.api.createRoom("legacy-${uniq()}")
        val dm = me.api.openDm(bob.user.id)
        val sent = (1..7).map { i ->
            val files = if (i == 4) listOf(UploadFile("dot.png", "image/png", png.toRequestBody("image/png".toMediaType()))) else emptyList()
            me.api.send(NewMessage(newId(), room.id, if (i == 5) "done 100%" else "m$i", files))
        }
        val since = sent.last().updated
        Thread.sleep(5)
        bob.api.send(NewMessage(newId(), room.id, "reply", replyTo = sent[1].id))
        bob.api.send(NewMessage(newId(), room.id, "not to me"))
        bob.api.send(NewMessage(newId(), dm.id, "dm"))
        me.api.edit(sent[2].id, "m3 edited")
        val c = Cursor(sent[3].created, sent[3].id)
        val texts = { ms: List<chirkle.android.data.model.Message> -> ms.map { it.text } }
        val out = listOf(
            me.api.listRooms().map { it.id == room.id || it.id == dm.id }.count { it },
            texts(me.api.page(Pages.latest(room.id), 3)),
            texts(me.api.page(Pages.first(room.id), 3)),
            texts(me.api.page(Pages.older(room.id, c), 2)),
            texts(me.api.page(Pages.newer(room.id, c), 2)),
            texts(me.api.page(Pages.withFiles(Pages.latest(room.id)))),
            texts(me.api.changes(Pages.changedIn(room.id, since, Cursor(sent[0].created, ""), Cursor(sent[6].created, "")))),
            texts(me.api.page(searchQuery(room.id, listOf("100%")))),
            texts(me.api.page(searchQuery(room.id, listOf("m")))),
            texts(me.api.page(searchQuery(room.id, listOf("m"), c))),
            texts(me.api.notifiable(listOf(room.id, dm.id), since)),
            texts(me.api.notifiable(listOf(room.id), since, every = setOf(room.id))),
        )
        out to me.calls.toList()
    }

    @Test fun `with a server from before the routes, the app falls back to the records API and sees the same`() {
        val (now, nowCalls) = scenario(TestServer.url)
        val (old, oldCalls) = scenario(TestServer.legacyUrl)
        assertEquals(
            listOf(
                2,
                listOf("not to me", "reply", "m7"),
                listOf("m1", "m2", "m3 edited"),
                listOf("m3 edited", "m2"),
                listOf("done 100%", "m6"),
                listOf("m4"),
                listOf("m3 edited"),
                listOf("done 100%"),
                listOf("not to me", "m7", "m6", "m4", "m3 edited", "m2", "m1"),
                listOf("m3 edited", "m2", "m1"),
                listOf("dm", "reply"),
                listOf("not to me", "reply"),
            ),
            now,
        )
        assertEquals(now, old)
        // A current server: the routes only; an old one: one 404, then the records API.
        assertFalse(nowCalls.toString(), nowCalls.any { it.endsWith("GET /api/collections/messages/records") || it.startsWith("404") })
        assertEquals(oldCalls.toString(), 1, oldCalls.count { it.startsWith("404") })
        assertTrue(oldCalls.toString(), oldCalls.none { it.contains("/api/chat/rooms/") || it.endsWith("/api/chat/notifiable") })
    }

    /** What a room's subscription and the activity of all rooms hear on the server at [at], and the client's requests. */
    private fun live(at: String): Pair<List<String>, List<String>> = runBlocking {
        val me = Recorded(at)
        val name = "live-${uniq()}"
        me.api.signUp("$name@test.local", TestServer.PASSWORD, name)
        val room = me.api.createRoom("live-${uniq()}")
        val other = me.api.createRoom("live-${uniq()}")
        val heard = Collections.synchronizedList(mutableListOf<String>())
        val offRoom = me.api.subscribeMessages(room.id) { heard += "room ${it.action} ${it.record.text}" }
        val offAll = me.api.subscribeAllMessages { heard += "all ${it.action}" }
        val m = me.api.send(NewMessage(newId(), room.id, "here"))
        me.api.send(NewMessage(newId(), other.id, "there"))
        me.api.edit(m.id, "here, edited")
        kotlinx.coroutines.withTimeout(10_000) { while (heard.size < 5) kotlinx.coroutines.delay(20) }
        offRoom()
        offAll()
        me.api.pb.realtime.unsubscribeAll()
        heard.sorted() to me.calls.toList()
    }

    @Test fun `with a server from before live messages, the app subscribes to the messages collection and hears the same`() {
        val (now, nowCalls) = live(TestServer.url)
        val (old, oldCalls) = live(TestServer.legacyUrl)
        assertEquals(listOf("all Create", "all Create", "all Update", "room Create here", "room Update here, edited"), now)
        assertEquals(now, old)
        // Asked once each: a current server says it sends them, an old one is a 404.
        assertEquals(nowCalls.toString(), 1, nowCalls.count { it == "200 GET /api/chat/live" })
        assertEquals(oldCalls.toString(), 1, oldCalls.count { it == "404 GET /api/chat/live" })
    }
}
