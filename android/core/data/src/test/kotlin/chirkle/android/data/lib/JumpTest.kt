package chirkle.android.data.lib

import chirkle.android.data.model.CollectionOwner
import chirkle.android.data.model.Collections
import chirkle.android.data.model.MediaCollection
import chirkle.android.data.model.Room
import org.junit.Assert.assertEquals
import org.junit.Test

// Jump to (§32): matching and ordering are shared/vectors/jump.json (VectorsTest); here, what a target says.
class JumpTest {
    private val general = Room("gen", "general", created = "2026-10-01 10:00:00.000Z")
    private val sections = RoomSections(listOf(general), emptyList(), emptyList(), emptyList())

    @Test fun `collections are found too, yours and those you follow, with whose they are (QA BUG-245)`() {
        val colls = Collections(
            mine = listOf(MediaCollection("c1", "Trip", lastAdded = "2026-10-05 10:00:00.000Z")),
            subs = listOf(MediaCollection("c2", "General pics", owner = CollectionOwner("bob", "Bob Été"))),
        )
        val all = jumpTargets(sections, "me", colls, { "" })
        val trip = jumpMatches(all, "trip").single()
        assertEquals("Collection" to "c1", trip.note to trip.id)
        assertEquals(null, trip.room)
        assertEquals(false, trip.away)
        assertEquals("Bob Été", jumpMatches(all, "pics").single().note)
    }

    @Test fun `a DM whose other member isn't known is "Unknown"`() {
        val dm = Room("dm", kind = "dm", members = listOf("me", "bob"))
        assertEquals("Unknown", jumpTargets(RoomSections(emptyList(), listOf(dm), emptyList(), emptyList()), "me", null, { "" }).single().name)
    }
}
