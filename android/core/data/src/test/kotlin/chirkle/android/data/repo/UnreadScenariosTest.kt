package chirkle.android.data.repo

import chirkle.android.data.api.NewMessage
import chirkle.android.data.lib.cases
import chirkle.android.data.lib.newId
import chirkle.android.data.lib.shared
import chirkle.android.data.lib.str
import chirkle.android.data.model.Message
import chirkle.android.data.testing.TestServer.newUser
import chirkle.android.data.testing.TestServer.uniq
import chirkle.android.data.testing.closeServices
import chirkle.android.data.testing.eventually
import chirkle.android.data.testing.services
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The unread counts' shared scenarios (shared/vectors/unread.json, docs/REFACTOR.md item 55), recorded from the web's
// unread.ts (tests/component/unread.scenarios.test.ts): Unread (Sync.kt) against the real server must come to the
// same counts.
@RunWith(RobolectricTestRunner::class)
class UnreadScenariosTest {
    @After fun tearDown() = closeServices()

    private val scenarios = shared("vectors/unread.json").cases("scenarios")

    private fun JsonObject.opt(name: String) = this[name]?.takeIf { it != JsonNull }?.jsonPrimitive?.content

    private fun counts(o: JsonObject): Map<String, Int> = o.mapValues { it.value.jsonPrimitive.int }

    @Test fun scenarios() = runBlocking {
        for (sc in scenarios) run(sc)
    }

    private suspend fun run(sc: JsonObject) {
        val name = sc.str("name")
        val me = newUser("me-${uniq()}")
        val people = mapOf("me" to me, "ann" to newUser("ann-${uniq()}"), "bob" to newUser("bob-${uniq()}"))
        val ann = people.getValue("ann")
        val rooms = mapOf("A" to ann.api.createRoom("a-${uniq()}"), "B" to ann.api.createRoom("b-${uniq()}"))
        val roomLabel = rooms.entries.associate { (label, room) -> room.id to label }
        val msgs = mutableMapOf<String, Message>()
        val s = services(me)
        // Settled before the first step, as the web's run: counted once, and following live.
        eventually(what = "$name: counted") { s.store.get().counted && rooms.values.all { it.id in s.store.get().rooms } }
        delay(1500)
        val readers = mutableMapOf<String, RoomReader>()

        // Only A and B: the server is shared with other tests, whose public rooms anyone may have unread messages in.
        fun byLabel(m: Map<String, Int>) = m.filter { (id, n) -> n > 0 && id in roomLabel }.mapKeys { roomLabel[it.key] ?: it.key }
        fun shown(): Map<String, Any> {
            val st = s.store.get()
            return mapOf("unread" to byLabel(st.unread), "mentions" to byLabel(st.mentions), "inbox" to st.inbox)
        }

        sc.cases("steps").forEachIndexed { i, step ->
            val room = step.opt("room")?.let { rooms.getValue(it) }
            when (step.str("do")) {
                "say" -> {
                    val label = step.str("label")
                    val text = if (step.opt("mention") == "true") "$label @${me.user.handle}" else label
                    val replyTo = step.opt("replyTo")?.let { msgs.getValue(it).id }.orEmpty()
                    msgs[label] = people.getValue(step.str("who")).api.send(NewMessage(newId(), room!!.id, text, replyTo = replyTo))
                }
                "react" -> people.getValue(step.str("who")).api.react(msgs.getValue(step.str("at")).id, "👍", true)
                "delete" -> people.getValue(step.str("who")).api.softDelete(msgs.getValue(step.str("at")).id)
                "open" -> readers[step.str("room")] = s.unread.open(room!!.id)
                "seen" -> readers.getValue(step.str("room")).seen(msgs.getValue(step.str("upTo")).created, step.getValue("caughtUp").jsonPrimitive.boolean)
                "close" -> readers.remove(step.str("room"))!!.close(step.getValue("caughtUp").jsonPrimitive.boolean)
                "readElsewhere" -> me.api.markRead(room!!.id, msgs.getValue(step.str("upTo")).created)
                "wait" -> delay(step.str("ms").toLong())
            }
            val e = step.getValue("expect").jsonObject
            val want = mapOf(
                "unread" to counts(e.getValue("unread").jsonObject),
                "mentions" to counts(e.getValue("mentions").jsonObject),
                "inbox" to e.getValue("inbox").jsonPrimitive.int,
            )
            try {
                eventually(what = "") { shown() == want }
            } catch (err: AssertionError) {
                throw AssertionError("$name, step ${i + 1} (${step.str("do")}):\n expected $want\n but was  ${shown()}")
            }
        }
        closeServices()
    }
}
