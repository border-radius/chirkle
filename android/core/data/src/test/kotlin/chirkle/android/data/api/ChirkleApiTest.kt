package chirkle.android.data.api

import chirkle.android.data.lib.Pages
import chirkle.android.data.lib.newId
import chirkle.android.data.model.Message
import chirkle.android.data.model.Visibility
import chirkle.android.data.pb.PbError
import chirkle.android.data.testing.TestServer
import chirkle.android.data.testing.TestServer.newUser
import chirkle.android.data.testing.TestServer.uniq
import kotlinx.coroutines.channels.Channel
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

// The API as the app uses it, against a real PocketBase with the repository's migrations and hooks (ANDROID.md §13).
class ChirkleApiTest {
    @Test fun `a shared room and people on linked instances decode, and an address on an instance not linked says so (§33)`() = runBlocking {
        val a = newUser()
        val b = newUser("b-${uniq()}")
        val room = a.api.createRoom("fed-${uniq()}")
        TestServer.admin("PATCH", "/api/collections/rooms/records/${room.id}", """{"shared":{"with":["b.example"]}}""")
        TestServer.admin("PATCH", "/api/collections/users/records/${b.user.id}", """{"instance":"b.example"}""")
        assertEquals(listOf("b.example"), a.api.getRoom(room.id).shared?.with)
        assertEquals("b.example", a.api.usersById(listOf(b.user.id)).single().instance)
        b.api.send(chirkle.android.data.api.NewMessage(newId(), room.id, "from B"))
        assertEquals("b.example", a.api.page(Pages.latest(room.id)).single().expand?.author?.instance)
        val e = runCatching { a.api.remoteUser("ann@nowhere.example") }.exceptionOrNull()
        assertEquals("This instance isn't linked to nowhere.example.", chirkle.android.data.api.reasonOf(e!!))
    }

    @Test fun `signs up, logs in, refreshes and logs out`() = runBlocking {
        val name = "ada-${uniq()}"
        val api = TestServer.client()
        val user = api.signUp("$name@test.local", TestServer.PASSWORD, name)
        assertEquals(name, user.name)
        assertEquals(user, api.currentUser())
        val other = TestServer.client()
        assertEquals(user.id, other.logIn("$name@test.local", TestServer.PASSWORD).id)
        assertEquals(user.id, other.refreshAuth().id)
        other.logOut()
        assertNull(other.currentUser())
    }

    @Test fun `a success that isn't the server's answer is network trouble, and the session is kept (QA BUG-158)`() = runBlocking {
        val a = newUser()
        val http = TestServer.http.newBuilder().addInterceptor { chain ->
            // A captive portal's, or a misconfigured proxy's, page instead of the answer.
            okhttp3.Response.Builder().request(chain.request()).protocol(okhttp3.Protocol.HTTP_1_1).code(200).message("OK")
                .body("<html>Sign in to the Wi-Fi</html>".toResponseBody("text/html".toMediaType())).build()
        }.build()
        val session = a.api.pb.authStore.session.value
        val api = ChirkleApi(chirkle.android.data.pb.PbClient(TestServer.url, http, chirkle.android.data.pb.MemoryAuthStore(session)))
        val e = runCatching { api.refreshAuth() }.exceptionOrNull()
        assertEquals(0, e?.toApiError()?.status)
        assertEquals(session.token, api.pb.authStore.session.value.token)
        assertEquals(0, runCatching { api.listRooms() }.exceptionOrNull()?.toApiError()?.status)
    }

    @Test fun `a renewal answered after a logout doesn't bring the session back`() = runBlocking {
        val a = newUser()
        val store = chirkle.android.data.pb.MemoryAuthStore(a.api.pb.authStore.session.value)
        // Logged out while the renewal is on its way.
        val http = TestServer.http.newBuilder().addInterceptor { chain ->
            if (chain.request().url.encodedPath.endsWith("/auth-refresh")) store.clear()
            chain.proceed(chain.request())
        }.build()
        val api = ChirkleApi(chirkle.android.data.pb.PbClient(TestServer.url, http, store))
        assertEquals(a.user.id, api.refreshAuth().id)
        assertNull(api.currentUser())
        assertEquals("", store.session.value.token)
    }

    @Test fun `JSON that isn't a session is network trouble too, not a crash`() = runBlocking {
        val a = newUser()
        val session = a.api.pb.authStore.session.value
        // A site that answers every path with JSON of its own: an object without a session, a list.
        for (body in listOf("""{"status":"ok"}""", """[1,2]""", """{"token":5,"record":{}}""")) {
            val http = TestServer.http.newBuilder().addInterceptor { chain ->
                okhttp3.Response.Builder().request(chain.request()).protocol(okhttp3.Protocol.HTTP_1_1).code(200).message("OK")
                    .body(body.toResponseBody("application/json".toMediaType())).build()
            }.build()
            val api = ChirkleApi(chirkle.android.data.pb.PbClient(TestServer.url, http, chirkle.android.data.pb.MemoryAuthStore(session)))
            val e = runCatching { api.refreshAuth() }.exceptionOrNull()
            assertTrue("$body: $e", e is ApiError && e.status == 0)
            assertEquals(session.token, api.pb.authStore.session.value.token)
        }
    }

    @Test fun `a wrong password is a 400 with the server's message`() = runBlocking {
        val u = newUser()
        try {
            TestServer.client().logIn(u.email, "wrong-password")
            fail("logged in")
        } catch (e: ApiError) {
            assertEquals(400, e.status)
            assertTrue(errorMessage(e).isNotBlank())
        }
    }

    @Test fun `sends with a client id, pages both ways by cursor, edits and deletes`() = runBlocking {
        val u = newUser()
        val room = u.api.createRoom("r-${uniq()}")
        val sent = (1..60).map { u.api.send(NewMessage(newId(), room.id, "m$it")) }
        assertEquals("m1", sent[0].text)
        assertEquals(u.user.id, sent[0].expand?.author?.id)
        // A retry with the same id is refused, never a duplicate (§17.4).
        try {
            u.api.send(NewMessage(sent[0].id, room.id, "again"))
            fail("duplicate")
        } catch (e: ApiError) {
            assertEquals(400, e.status)
        }
        val latest = u.api.page(Pages.latest(room.id))
        assertEquals(50, latest.size)
        assertEquals("m60", latest[0].text)
        val older = u.api.page(Pages.older(room.id, chirkle.android.data.model.Cursor(latest.last().created, latest.last().id)))
        assertEquals((10 downTo 1).map { "m$it" }, older.map { it.text })
        val edited = u.api.edit(sent[1].id, "changed")
        assertEquals("changed", edited.text)
        assertNotEquals("", edited.editedAt)
        assertTrue(u.api.softDelete(sent[2].id).deleted)
    }

    @Test fun `binds filter values instead of concatenating them`() = runBlocking {
        val u = newUser()
        val room = u.api.createRoom("r-${uniq()}")
        u.api.send(NewMessage(newId(), room.id, "hello"))
        val evil = "x\" || room != \""
        assertEquals("room = \"x\\\" || room != \\\"\"", u.api.pb.filter("room = {:room}", mapOf("room" to evil)))
        assertEquals(emptyList<Message>(), u.api.page(Pages.latest(evil)))
    }

    @Test fun `reacts, replies and forwards`() = runBlocking {
        val u = newUser()
        val room = u.api.createRoom("r-${uniq()}")
        val first = u.api.send(NewMessage(newId(), room.id, "first"))
        val reply = u.api.send(NewMessage(newId(), room.id, "reply", replyTo = first.id))
        assertEquals("first", reply.expand?.replyTo?.text)
        assertEquals(listOf(u.user.id), u.api.react(first.id, "👍", true).reactions.single().users)
        assertEquals(emptyList<Any>(), u.api.react(first.id, "👍", false).reactions)
        val other = u.api.createRoom("r-${uniq()}")
        val copies = u.api.forward(listOf(first.id), other.id)
        assertEquals(u.user.id, copies.single().forwardedFrom)
        assertEquals(2, u.api.deleteMany(listOf(first.id, reply.id)).count { it.deleted })
    }

    @Test fun `rooms, access, hidden rows, DMs and unread counts`() = runBlocking {
        val a = newUser()
        val b = newUser()
        val room = a.api.createRoom("r-${uniq()}", Visibility.Private)
        assertEquals(Visibility.Private, room.visibility)
        assertFalse(b.api.listRooms().any { it.id == room.id })
        a.api.setAccess(room.id, Visibility.Private, listOf(a.user.id, b.user.id))
        assertTrue(b.api.listRooms().any { it.id == room.id })
        a.api.send(NewMessage(newId(), room.id, "hi b"))
        assertEquals(1, b.api.unreadCounts().rooms[room.id])
        val firstUnread = b.api.firstUnread(room.id)
        assertNotEquals("", firstUnread.id)
        b.api.markRead(room.id, firstUnread.created)
        assertNull(b.api.unreadCounts().rooms[room.id])
        val row = b.api.hideRoom(room.id)
        assertEquals(listOf(room.id), b.api.listHidden().map { it.room }.filter { it == room.id })
        b.api.unhideRoom(row.id)
        val dm = a.api.openDm(b.user.id)
        assertTrue(dm.isDm)
        assertEquals(setOf(a.user.id, b.user.id), dm.members.toSet())
        assertTrue(a.api.searchUsers(b.user.name.uppercase()).any { it.id == b.user.id })
        assertEquals(listOf(b.user.name), a.api.usersById(listOf(b.user.id)).map { it.name })
    }

    @Test fun `the site record, with the defaults when there is none`() = runBlocking {
        val site = TestServer.client().site()
        assertTrue(site.title.isNotEmpty())
    }

    @Test fun `this server opens files by URL alone, so the app asks for no file token`() = runBlocking {
        val u = newUser()
        assertFalse(u.api.needsFileTokens())
        assertFalse(TestServer.client().needsFileTokens())
    }

    @Test fun `an older server's file token is still there to be asked for`() = runBlocking {
        val u = newUser()
        val token = u.api.newFileToken()
        assertTrue(token.isNotEmpty())
        assertEquals("", TestServer.client().newFileToken())
    }

    @Test fun `realtime delivers the room's events once subscribed`() = runBlocking {
        val u = newUser()
        val room = u.api.createRoom("r-${uniq()}")
        val events = Channel<Change<Message>>(Channel.UNLIMITED)
        val off = u.api.subscribeMessages(room.id) { events.trySend(it) }
        val sent = u.api.send(NewMessage(newId(), room.id, "live"))
        val e = withTimeout(10_000) { events.receive() }
        assertEquals(Action.Create, e.action)
        assertEquals(sent.id, e.record.id)
        assertEquals(u.user.id, e.record.expand?.author?.id)
        u.api.edit(sent.id, "edited")
        assertEquals("edited", withTimeout(10_000) { events.receive() }.record.text)
        off()
        u.api.pb.realtime.unsubscribeAll()
    }

    @Test fun `realtime reconnects after a pause and says events may have been missed`() = runBlocking {
        val u = newUser()
        val room = u.api.createRoom("r-${uniq()}")
        val connects = Channel<Boolean>(Channel.UNLIMITED)
        val job = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default).launchCollect(u.api, connects)
        val events = Channel<Change<Message>>(Channel.UNLIMITED)
        u.api.subscribeMessages(room.id) { events.trySend(it) }
        assertEquals(false, withTimeout(10_000) { connects.receive() })
        u.api.pb.realtime.pause()
        kotlinx.coroutines.delay(300)
        assertFalse(u.api.pb.realtime.isConnected)
        u.api.pb.realtime.resume()
        assertEquals(true, withTimeout(10_000) { connects.receive() })
        u.api.send(NewMessage(newId(), room.id, "after"))
        assertEquals("after", withTimeout(10_000) { events.receive() }.record.text)
        job.cancel()
        u.api.pb.realtime.unsubscribeAll()
    }

    @Test fun `PbError keeps the field codes`() {
        val e = PbError(400, chirkle.android.data.pb.PbJson.parseToJsonElement("""{"message":"x","data":{"name":{"code":"validation_not_unique","message":"taken"}}}""") as kotlinx.serialization.json.JsonObject)
        assertEquals(mapOf("name" to "validation_not_unique"), e.codes)
        assertEquals(mapOf("name" to "taken"), e.toApiError().fields)
    }
}

private fun kotlinx.coroutines.CoroutineScope.launchCollect(api: ChirkleApi, into: Channel<Boolean>) =
    launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { api.connects.collect { into.trySend(it) } }
