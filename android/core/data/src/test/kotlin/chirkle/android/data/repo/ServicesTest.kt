package chirkle.android.data.repo

import chirkle.android.data.api.NewMessage
import chirkle.android.data.lib.PageKind
import chirkle.android.data.lib.newId
import chirkle.android.data.model.SendStatus
import chirkle.android.data.model.Visibility
import chirkle.android.data.testing.TestServer
import chirkle.android.data.testing.TestServer.newUser
import chirkle.android.data.testing.TestServer.uniq
import chirkle.android.data.testing.eventually
import chirkle.android.data.testing.closeServices
import chirkle.android.data.testing.services
import chirkle.android.data.testing.testDb
import chirkle.android.data.db.DraftEntity
import chirkle.android.data.db.RoomEntity
import chirkle.android.data.model.Room
import chirkle.android.data.pb.PbJson
import chirkle.android.data.pb.Session
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The services and the room controller as the screens use them, against the real server (ANDROID.md §13).
@RunWith(RobolectricTestRunner::class)
class ServicesTest {
    @After fun tearDown() = closeServices()

    @Test fun `the room list loads, follows realtime and is saved for the next launch`() = runBlocking {
        val u = newUser()
        val s = services(u)
        eventually(what = "rooms ready") { s.store.get().roomsStatus == LoadStatus.Ready }
        val room = u.api.createRoom("r-${uniq()}")
        eventually(what = "the new room") { room.id in s.store.get().rooms }
        eventually(what = "saved") { runBlocking { s.db.rooms().all().any { it.id == room.id } } }
        u.api.setArchived(room.id, true)
        eventually(what = "archived") { s.store.get().rooms[room.id]?.archived == true }
    }

    @Test fun `a guest sees Open Air rooms only, and can't post`() = runBlocking {
        val u = newUser()
        val open = u.api.createRoom("open-${uniq()}", Visibility.Open)
        val private = u.api.createRoom("priv-${uniq()}", Visibility.Private)
        u.api.send(NewMessage(newId(), open.id, "hello guests"))
        val g = services(null)
        eventually(what = "rooms") { g.store.get().roomsStatus == LoadStatus.Ready }
        assertTrue(open.id in g.store.get().rooms)
        assertFalse(private.id in g.store.get().rooms)
        val c = g.openRoom(open.id)
        eventually(what = "messages") { c.state.value.items.any { it.text == "hello guests" } }
        assertFalse(c.posting())
        assertFalse(c.send("hi"))
        c.close()
    }

    @Test fun `sends through the outbox, follows live messages, edits, reacts and deletes`() = runBlocking {
        val a = newUser()
        val b = newUser()
        val room = a.api.createRoom("r-${uniq()}")
        val s = services(a)
        val c = s.openRoom(room.id)
        eventually(what = "ready") { c.state.value.phase == Phase.Ready }
        assertTrue(c.send("from the app"))
        eventually(what = "pending shown") { c.state.value.items.any { it.text == "from the app" } }
        eventually(what = "sent") { c.state.value.items.any { it.text == "from the app" && it.status == null } }
        assertEquals(listOf("from the app"), a.api.page(chirkle.android.data.lib.Pages.latest(room.id)).map { it.text })
        b.api.send(NewMessage(newId(), room.id, "from b"))
        eventually(what = "live") { c.state.value.items.any { it.text == "from b" } }
        val mine = c.state.value.items.first { it.text == "from the app" }
        assertTrue(c.edit(mine.id, "edited")!!.await())
        assertEquals("edited", c.find(mine.id)!!.text)
        val theirs = c.state.value.items.first { it.text == "from b" }
        assertTrue(c.react(theirs.id, "👍", true)!!.await())
        eventually(what = "reaction") { c.find(theirs.id)!!.reactions.singleOrNull()?.users == listOf(a.user.id) }
        assertNull("not mine to delete", c.remove(theirs.id)?.let { if (c.deletable(theirs)) it else null })
        assertTrue(c.remove(mine.id)!!.await())
        assertTrue(c.find(mine.id)!!.deleted)
        c.close()
        // Kept for next time: the room opens from it at once.
        eventually(what = "kept") { s.cache.peek(a.user.id, room.id)?.items?.size == 2 }
    }

    @Test fun `a reply is sent with its quote`() = runBlocking {
        val a = newUser()
        val room = a.api.createRoom("r-${uniq()}")
        val q = a.api.send(NewMessage(newId(), room.id, "the question"))
        val s = services(a)
        val c = s.openRoom(room.id)
        eventually(what = "ready") { c.find(q.id) != null }
        assertTrue(c.send("the answer", replyTo = c.find(q.id)))
        eventually(what = "sent with reply_to") { runBlocking { a.api.page(chirkle.android.data.lib.Pages.latest(room.id)).any { it.text == "the answer" && it.replyTo == q.id } } }
        eventually(what = "shown as sent") { c.state.value.items.any { it.text == "the answer" && it.status == null && it.expand?.replyTo?.text == "the question" } }
        c.close()
    }

    @Test fun `a live reply quotes the message in the window, and keeps the quote through an edit`() = runBlocking {
        val a = newUser()
        val b = newUser()
        val room = a.api.createRoom("r-${uniq()}")
        val q = b.api.send(NewMessage(newId(), room.id, "the original"))
        // The server sends live events without the quote (docs/PERF.md §2.3).
        val events = kotlinx.coroutines.channels.Channel<chirkle.android.data.model.Message>(kotlinx.coroutines.channels.Channel.UNLIMITED)
        val off = b.api.subscribeMessages(room.id) { events.trySend(it.record) }
        val s = services(a)
        val c = s.openRoom(room.id)
        eventually(what = "ready") { c.find(q.id) != null }
        val reply = b.api.send(NewMessage(newId(), room.id, "a reply", replyTo = q.id))
        assertNull(kotlinx.coroutines.withTimeout(10_000) { events.receive() }.expand?.replyTo)
        eventually(what = "quoted") { c.find(reply.id)?.expand?.replyTo?.text == "the original" }
        assertEquals(b.user.name, c.find(reply.id)!!.expand?.replyTo?.expand?.author?.name)
        b.api.edit(reply.id, "a reply, edited")
        eventually(what = "edited") { c.find(reply.id)?.text == "a reply, edited" }
        assertEquals("the original", c.find(reply.id)!!.expand?.replyTo?.text)
        off()
        c.close()
    }

    @Test fun `a live reply to a message beyond the window fetches its quote`() = runBlocking {
        val a = newUser()
        val b = newUser()
        val room = a.api.createRoom("r-${uniq()}")
        val sent = (1..60).map { a.api.send(NewMessage(newId(), room.id, "m$it")) }
        val s = services(a)
        val c = s.openRoom(room.id)
        eventually(what = "ready") { c.find(sent.last().id) != null }
        assertNull(c.find(sent[0].id))
        val reply = b.api.send(NewMessage(newId(), room.id, "way back", replyTo = sent[0].id))
        eventually(what = "quoted") { c.find(reply.id)?.expand?.replyTo?.text == "m1" }
        c.close()
    }

    @Test fun `opens around a message far back, and jumps to the latest`() = runBlocking {
        val a = newUser()
        val room = a.api.createRoom("r-${uniq()}")
        val sent = (1..130).map { a.api.send(NewMessage(newId(), room.id, "m$it")) }
        val s = services(a)
        val c = s.openRoom(room.id, msgId = sent[9].id)
        eventually(what = "around") { c.state.value.targetId == sent[9].id }
        assertTrue(c.state.value.hasNewer)
        assertTrue(c.state.value.items.any { it.id == sent[9].id })
        c.jump(PageKind.Latest)
        eventually(what = "latest") { c.state.value.items.lastOrNull()?.id == sent.last().id && !c.state.value.hasNewer }
        c.goTo(sent[1].id)
        eventually(what = "went back") { c.state.value.targetId == sent[1].id && c.state.value.items.any { it.id == sent[1].id } }
        c.close()
    }

    @Test fun `counts unread messages live, and reading the room clears them on the server`() = runBlocking {
        val a = newUser()
        val b = newUser()
        val room = a.api.createRoom("r-${uniq()}")
        val s = services(b)
        eventually(what = "counted") { s.store.get().counted && room.id in s.store.get().rooms }
        a.api.send(NewMessage(newId(), room.id, "one"))
        a.api.send(NewMessage(newId(), room.id, "two"))
        eventually(what = "two unread") { s.store.get().unread[room.id] == 2 }
        val c = s.openRoom(room.id)
        eventually(what = "opened at the first unread") { c.state.value.unreadId != null }
        val reader = s.unread.open(room.id)
        reader.seen(c.state.value.items.last().created, caughtUp = true)
        reader.close(caughtUp = true)
        eventually(what = "read on the server") { runBlocking { b.api.unreadCounts().rooms[room.id] == null } }
        c.close()
        s.closeRoom(room.id)
    }

    @Test fun `an open room not read to the end keeps its count and badge, brought down to what is left`() = runBlocking {
        val a = newUser()
        val b = newUser()
        val room = a.api.createRoom("r-${uniq()}")
        val s = services(b)
        eventually(what = "counted") { s.store.get().counted && room.id in s.store.get().rooms }
        val sent = (1..3).map { a.api.send(NewMessage(newId(), room.id, "m$it")) }
        eventually(what = "three unread") { s.store.get().unread[room.id] == 3 }
        val c = s.openRoom(room.id)
        val reader = s.unread.open(room.id)
        reader.seen(sent[0].created, caughtUp = false)
        eventually(what = "two left") { s.store.get().unread[room.id] == 2 }
        val st = s.store.get()
        assertEquals(2, chirkle.android.data.lib.unreadBadge(st.rooms.getValue(room.id), st.unread, st.hidden.keys))
        // Scrolled up: a new message stays unread too.
        a.api.send(NewMessage(newId(), room.id, "m4"))
        eventually(what = "three left") { s.store.get().unread[room.id] == 3 }
        reader.seen(sent[2].created, caughtUp = true)
        eventually(what = "caught up") { s.store.get().unread[room.id] == null }
        reader.close(caughtUp = true)
        c.close()
        s.closeRoom(room.id)
    }

    @Test fun `a read that fails on the way is sent again, with nothing new on screen`() = runBlocking {
        val a = newUser()
        val b = newUser()
        val room = a.api.createRoom("r-${uniq()}")
        // The network comes back just after the message showed: the first read doesn't get through.
        var failed = 0
        val http = TestServer.http.newBuilder().addInterceptor { chain ->
            if (chain.request().url.encodedPath == "/api/chat/reads" && failed++ == 0) throw java.io.IOException("offline")
            chain.proceed(chain.request())
        }.build()
        val main = java.util.concurrent.Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val s = ChirkleServices(TestServer.url, http, chirkle.android.data.pb.MemoryAuthStore(b.api.pb.authStore.session.value), testDb(), main)
        try {
            s.start()
            eventually(what = "counted") { s.store.get().counted && room.id in s.store.get().rooms }
            val m = a.api.send(NewMessage(newId(), room.id, "one"))
            eventually(what = "unread") { s.store.get().unread[room.id] == 1 }
            val reader = kotlinx.coroutines.withContext(main) { s.unread.open(room.id) }
            kotlinx.coroutines.withContext(main) { reader.seen(m.created, caughtUp = true) }
            // No other seen(): the room on screen doesn't change.
            eventually(ms = 15_000, what = "read on the server") { runBlocking { b.api.unreadCounts().rooms[room.id] == null } }
            assertTrue(failed >= 2)
        } finally {
            s.close()
        }
    }

    @Test fun `a refused send shows as failed and can be discarded`() = runBlocking {
        val a = newUser()
        val room = a.api.createRoom("r-${uniq()}")
        val s = services(a)
        val c = s.openRoom(room.id)
        eventually(what = "ready") { c.state.value.phase == Phase.Ready }
        assertTrue(c.send("x".repeat(2001))) // over the limit: the server refuses it
        eventually(what = "failed") { c.state.value.items.any { it.status == SendStatus.Failed } }
        c.discard(c.state.value.items.first { it.status == SendStatus.Failed }.id)
        eventually(what = "gone") { c.state.value.items.isEmpty() }
        c.close()
    }

    @Test fun `logging out clears the session's data`() = runBlocking {
        val a = newUser()
        val s = services(a)
        eventually(what = "rooms") { s.store.get().roomsStatus == LoadStatus.Ready }
        a.api.createRoom("r-${uniq()}")
        eventually(what = "saved") { runBlocking { s.db.rooms().all().isNotEmpty() } }
        s.logOut()
        eventually(what = "cleared") { s.store.get().user == null && runBlocking { s.db.rooms().all().none { it.json.contains("\"private\"") } } }
        assertNull(s.api.currentUser())
    }

    @Test fun `a private room you are taken out of is kept empty, though it wasn't open (QA BUG-160)`() = runBlocking {
        val ada = newUser()
        val bob = newUser()
        val room = ada.api.createRoom("secret-${uniq()}", Visibility.Private)
        ada.api.setAccess(room.id, Visibility.Private, listOf(bob.user.id))
        val m = ada.api.send(chirkle.android.data.api.NewMessage(chirkle.android.data.lib.newId(), room.id, "for bob's eyes"))
        val s = services(bob)
        eventually(what = "the room listed") { s.store.get().roomsStatus == LoadStatus.Ready && room.id in s.store.get().rooms }
        s.cache.put(bob.user.id, room.id, Kept(listOf(m), false)) // prefetched
        ada.api.setAccess(room.id, Visibility.Private, emptyList())
        eventually(what = "the room gone") { room.id !in s.store.get().rooms }
        eventually(what = "kept empty") { runBlocking { s.cache.get(bob.user.id, room.id)?.items?.isEmpty() == true } }
    }

    @Test fun `a room opened again before its screen closes stays the active room`() = runBlocking {
        val a = newUser()
        val room = a.api.createRoom("r-${uniq()}")
        val other = a.api.createRoom("r-${uniq()}")
        val s = services(a)
        // A link (or a notification) to the room on screen opens a new screen of it; the old one goes after.
        val first = s.openRoom(room.id)
        val second = s.openRoom(room.id, msgId = null)
        first.close()
        s.closeRoom(room.id)
        assertEquals(room.id, s.store.get().activeRoomId)
        // And to another room: that one is active once the old screen goes.
        val third = s.openRoom(other.id)
        second.close()
        s.closeRoom(room.id)
        assertEquals(other.id, s.store.get().activeRoomId)
        third.close()
        s.closeRoom(other.id)
        assertNull(s.store.get().activeRoomId)
    }

    @Test fun `Jump to forgets which rooms were opened when the session ends (QA BUG-152)`() = runBlocking {
        val a = newUser()
        val s = services(a)
        eventually(what = "rooms") { s.store.get().roomsStatus == LoadStatus.Ready }
        s.opened.note("some-room")
        assertTrue(s.opened["some-room"].isNotEmpty())
        s.logOut()
        eventually(what = "logged out") { s.store.get().user == null }
        assertEquals("", s.opened["some-room"])
    }

    @Test fun `a session revoked elsewhere ends when the app comes back after a while (QA BUG-183)`() = runBlocking {
        val a = newUser()
        val s = services(a)
        s.setVisible(false)
        // Another device (the user's own client) changes the password: every other session is revoked.
        a.api.changePassword(TestServer.PASSWORD, "password456")
        s.setVisible(true) // back at once: not checked again
        kotlinx.coroutines.delay(500)
        assertEquals(a.user.id, s.store.get().user?.id)
        s.checkStaleMs = 0
        s.setVisible(false)
        s.setVisible(true)
        eventually(what = "logged out") { s.store.get().user == null }
    }

    @Test fun `a room of yours that "doesn't exist" checks the session, which ends if revoked (QA BUG-183)`() = runBlocking {
        val a = newUser()
        val room = a.api.createRoom("rv-${uniq()}")
        val s = services(a)
        eventually(what = "room listed") { room.id in s.store.get().rooms }
        a.api.changePassword(TestServer.PASSWORD, "password456")
        s.openRoom(room.id)
        eventually(what = "logged out") { s.store.get().user == null }
    }

    @Test fun `a session that ran out while the app was closed leaves nothing of it, even for a moment (QA BUG-145)`() = runBlocking {
        val a = newUser()
        val secret = a.api.createRoom("secret-${uniq()}", Visibility.Private)
        val db = testDb()
        db.rooms().upsert(listOf(RoomEntity(secret.id, PbJson.encodeToString(Room.serializer(), secret))))
        db.drafts().put(DraftEntity(a.user.id, secret.id, "half-written"))
        val stored = a.api.pb.authStore.session.value
        val exp = System.currentTimeMillis() / 1000 - 60
        val payload = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString("""{"exp":$exp}""".toByteArray())
        val s = services(null, session = Session("x.$payload.x", stored.record), db = db)
        assertNull(s.store.get().user)
        assertFalse(secret.id in s.store.get().rooms)
        assertTrue(db.rooms().all().none { it.id == secret.id })
        assertNull(db.drafts().get(a.user.id, secret.id))
        assertNull(s.api.pb.authStore.session.value.record)
    }
}
