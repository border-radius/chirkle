package chirkle.android.data.lib

import chirkle.android.data.model.CollectionOwner
import chirkle.android.data.model.Collections
import chirkle.android.data.model.Cursor
import chirkle.android.data.model.MediaCollection
import chirkle.android.data.model.Room
import chirkle.android.data.model.RoomExpand
import chirkle.android.data.model.User
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

// The shared test vectors (shared/vectors/): the cases the web (tests/unit/vectors.test.ts) and the server's
// pb_hooks/lib/text.js pass too.
class VectorsTest {
    private val text = shared("vectors/text.json")
    private val jump = shared("vectors/jump.json")
    private val mentions = shared("vectors/mentions.json")

    @Test fun splitMentions() {
        for (c in mentions.cases("mentions")) {
            val input = c.str("input")
            assertEquals(input, c.strings("handles"), mentionedHandles(input))
            val parts = c.getValue("parts").jsonArray.map {
                if (it is JsonPrimitive) TextPart.Plain(it.content) else TextPart.Mention(it.jsonObject.str("handle"), it.jsonObject.str("text"))
            }
            assertEquals(input, parts, splitMentions(input))
        }
    }

    @Test fun mentionToken() {
        assertEquals(MentionToken(3, "an"), mentionToken("hi @An", 6))
        assertEquals(MentionToken(0, ""), mentionToken("@", 1))
        assertEquals(null, mentionToken("ann@ex", 6))
        assertEquals(null, mentionToken("hi @ann ", 8))
    }

    @Test fun foldKey() {
        for (c in text.cases("foldKey")) assertEquals(c.str("input"), c.str("output"), foldKey(c.str("input")))
    }

    @Test fun searchWords() {
        for (c in text.cases("searchWords")) assertEquals(c.str("input"), c.strings("output"), searchWords(c.str("input")))
    }

    @Test fun searchQuery() {
        for (c in text.cases("searchQuery")) {
            val before = c.getValue("before").takeIf { it != JsonNull }?.jsonObject?.let { Cursor(it.str("created"), it.str("id")) }
            val q = searchQuery(c.str("room"), c.strings("words"), before)
            val route = c.getValue("output").jsonObject.getValue("route").jsonObject
            assertEquals(route.str("room"), q.room)
            assertEquals(route.str("kind"), q.kind)
            assertEquals(route.getValue("args").jsonObject.mapValues { it.value.jsonPrimitive.content }, q.args)
            assertEquals(route.str("q"), q.q)
            // The filter sent to a server from before the route.
            val out = c.getValue("output").jsonObject.getValue("legacy").jsonObject
            val old = q.legacy()
            assertEquals(out.str("filter"), old.filter)
            assertEquals(out.getValue("params").jsonObject.mapValues { it.value.jsonPrimitive.content }, old.params)
            assertEquals(out.str("sort"), old.sort)
        }
    }

    @Test fun highlight() {
        for (c in text.cases("highlight")) assertEquals(c.str("text"), c.strings("output"), highlight(c.str("text"), c.strings("words")))
    }

    @Test fun textLength() {
        for (c in text.cases("textLength")) assertEquals(c.str("input"), c.num("output"), textLength(c.str("input")))
    }

    @Test fun isBlank() {
        for (c in text.cases("isBlank")) assertEquals(c.str("input"), c.getValue("output").jsonPrimitive.boolean, isBlank(c.str("input")))
    }

    @Test fun jumpFold() {
        for (c in jump.cases("fold")) assertEquals(c.str("output"), jumpFold(c.str("input")))
    }

    @Test fun jumpScore() {
        for (c in jump.cases("score")) assertEquals("${c.str("name")} / ${c.str("query")}", c.num("output"), jumpScore(c.str("name"), jumpFold(c.str("query"))))
    }

    @Test fun jumpOrder() {
        for (c in jump.cases("order")) assertEquals(c.str("name"), c.strings("output"), jumpNames(c))
    }
}

/** A case of jump.json "order" through [jumpTargets] and [jumpMatches], as the room list's search does: the names shown. */
private fun jumpNames(c: JsonObject): List<String> {
    val me = User("me", "Me")
    fun JsonObject.opt(name: String) = this[name]?.takeIf { it != JsonNull }?.jsonPrimitive?.content
    fun room(r: JsonObject, archived: Boolean = false): Room {
        val dm = r.opt("dm")
        val other = User("u-${r.str("id")}", dm.orEmpty())
        return Room(
            r.str("id"),
            r.opt("name").orEmpty(),
            archived = archived,
            kind = if (dm != null) "dm" else "room",
            members = if (dm != null) listOf(me.id, other.id) else emptyList(),
            lastMessageAt = r.opt("last_message_at").orEmpty(),
            created = r.str("created"),
            expand = if (dm != null) RoomExpand(members = listOf(me, other)) else null,
        )
    }
    fun rooms(name: String, archived: Boolean = false) = c.getValue("sections").jsonObject.cases(name).map { room(it, archived) }
    val filler = c["filler"]?.jsonObject?.let { f -> List(f.num("count")) { Room("f$it", "room $it", created = f.str("created")) } }.orEmpty()
    val sections = RoomSections(rooms("rooms") + filler, rooms("dms"), rooms("hidden"), rooms("archived", archived = true))
    fun colls(name: String) = c.getValue("collections").jsonObject.cases(name).map { x ->
        val owner = x["owner"]?.jsonObject?.let { CollectionOwner(it.str("id"), it.str("name")) }
        MediaCollection(x.str("id"), x.str("name"), lastAdded = x.str("last_added"), owner = owner)
    }
    val opened = c.getValue("opened").jsonObject.mapValues { it.value.jsonPrimitive.content }
    val all = jumpTargets(sections, me.id, Collections(colls("mine"), colls("subs")), { opened[it].orEmpty() }, c.opt("current"))
    return jumpMatches(all, c.str("query")).map { it.name }
}
