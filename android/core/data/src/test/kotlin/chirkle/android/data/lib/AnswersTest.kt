package chirkle.android.data.lib

import chirkle.android.data.model.Badge
import chirkle.android.data.model.ExportStatus
import chirkle.android.data.model.InviteAnswer
import chirkle.android.data.model.InvitePreview
import chirkle.android.data.model.Joined
import chirkle.android.data.model.CollectionItem
import chirkle.android.data.model.Collections
import chirkle.android.data.model.Cursor
import chirkle.android.data.model.InboxPage
import chirkle.android.data.model.MediaPage
import chirkle.android.data.model.Mentionable
import chirkle.android.data.model.Message
import chirkle.android.data.model.ReadPosition
import chirkle.android.data.model.Room
import chirkle.android.data.model.UnreadCounts
import chirkle.android.data.model.User
import chirkle.android.data.pb.PbJson
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// The routes' answers as shared/schema/answers.json gives them (docs/API.md, docs/REFACTOR.md item 54): each example
// decodes with the model ChirkleApi decodes that route's answer with, and PbJson (the app's settings). The integration
// tests check the server's real answers against the same schemas, so an answer the app can't read fails one side.
class AnswersTest {
    private val routes = shared("schema/answers.json").getValue("routes").jsonObject

    /** What ChirkleApi decodes each route's answer as. */
    private val decoders: Map<String, KSerializer<*>> = mapOf(
        "GET /api/chat/rooms" to ListSerializer(Room.serializer()),
        "GET /api/chat/rooms/{room}/messages" to ListSerializer(Message.serializer()),
        "GET /api/chat/notifiable" to ListSerializer(Message.serializer()),
        "GET /api/chat/unread" to UnreadCounts.serializer(),
        "GET /api/chat/unread/{room}" to Cursor.serializer(),
        "POST /api/chat/reads" to ReadPosition.serializer(),
        "POST /api/chat/dms" to Room.serializer(),
        "GET /api/chat/users" to ListSerializer(User.serializer()),
        "POST /api/chat/remote-users" to User.serializer(),
        "GET /api/chat/mentionable" to ListSerializer(Mentionable.serializer()),
        "GET /api/chat/inbox" to InboxPage.serializer(),
        "POST /api/chat/reactions" to Message.serializer(),
        "POST /api/chat/delete" to ListSerializer(Message.serializer()),
        "POST /api/chat/forward" to ListSerializer(Message.serializer()),
        "GET /api/chat/media/{room}" to MediaPage.serializer(),
        "GET /api/chat/collections" to Collections.serializer(),
        "GET /api/chat/badges" to MapSerializer(String.serializer(), Badge.serializer().nullable),
        "POST /api/chat/items" to CollectionItem.serializer(),
        "GET /api/chat/saved" to MapSerializer(String.serializer(), String.serializer()),
        "GET /api/chat/export" to ExportStatus.serializer(),
        "POST /api/chat/export" to ExportStatus.serializer(),
        "GET /api/chat/rooms/{room}/invite" to InviteAnswer.serializer(),
        "POST /api/chat/rooms/{room}/invite" to InviteAnswer.serializer(),
        "GET /api/chat/invites/{token}" to InvitePreview.serializer(),
        "POST /api/chat/invites/{token}" to Joined.serializer(),
    )

    /**
     * Routes whose answer the app reads some other way, or not at all: each with why. A route new in answers.json goes
     * in one of the two lists.
     */
    private val notDecoded = mapOf(
        "GET /api/chat/live" to "only whether it answers (404 on a server from before)",
        "POST /api/chat/password" to "auth() takes token and record apart, the record as a User (below)",
        "POST /api/chat/ban" to "the answer is ignored",
        "POST /api/chat/inbox/seen" to "the answer is ignored",
        "POST /api/chat/subs" to "the answer is ignored",
        "POST /api/chat/subs/seen" to "the answer is ignored",
        "GET /api/chat/stats" to "the web's /stats page only",
        "GET /api/chat/metrics" to "the web's /stats page only",
    )

    private fun examples(route: String): List<JsonElement> = routes.getValue(route).jsonObject.getValue("examples").jsonArray

    @Test fun `every route in answers json is decoded or says why not`() {
        val listed = decoders.keys + notDecoded.keys
        assertEquals(emptySet<String>(), routes.keys - listed)
        assertEquals(emptySet<String>(), listed - routes.keys)
    }

    @Test fun `the examples decode with the app's models`() {
        for ((route, serializer) in decoders) {
            for ((i, ex) in examples(route).withIndex()) {
                val decoded = runCatching { PbJson.decodeFromJsonElement(serializer, ex) }
                assertTrue("$route example $i: ${decoded.exceptionOrNull()?.message}", decoded.isSuccess)
            }
        }
    }

    @Test fun `a password change's record is a User`() {
        for (ex in examples("POST /api/chat/password")) {
            val record = ex.jsonObject.getValue("record") as JsonObject
            assertEquals(record.getValue("id").toString().trim('"'), PbJson.decodeFromJsonElement(User.serializer(), record).id)
        }
    }

    @Test fun `what the models keep of the examples`() {
        val page = PbJson.decodeFromJsonElement(ListSerializer(Message.serializer()), examples("GET /api/chat/rooms/{room}/messages")[0])
        assertEquals(listOf(640, 480), page[0].fileDims["cat_cani1ag7yw.png"])
        assertEquals("Bob", page[0].expand?.replyTo?.expand?.author?.name)
        val inbox = PbJson.decodeFromJsonElement(InboxPage.serializer(), examples("GET /api/chat/inbox")[0])
        assertEquals(listOf("m00000000000000", null), inbox.items.map { it.quote?.id })
        val badges = PbJson.decodeFromJsonElement(MapSerializer(String.serializer(), Badge.serializer().nullable), examples("GET /api/chat/badges")[0])
        assertEquals(true, badges["c00000000000003"]?.private)
        assertEquals(null, badges["c00000000000004"])
    }
}
