package chirkle.android.data.lib

import chirkle.android.data.model.Room
import org.junit.Assert.assertEquals
import org.junit.Test

// The room list's order: the cases of tests/unit/store.test.ts "roomSections".
class RoomSectionsTest {
    private fun dm(id: String, last: String) = Room(id, kind = "dm", members = listOf("me", "u$id"), lastMessageAt = last, createdBy = "me")
    private val rooms = listOf(
        dm("a", "2026-03-01 00:00:00.000Z"),
        dm("b", "2026-04-01 00:00:00.000Z"),
        dm("c", "2026-05-01 00:00:00.000Z"),
        Room("p", "alpha"),
        Room("q", "beta"),
        Room("r", "gamma"),
    )

    @Test fun `rooms by name and DMs by latest activity`() {
        val s = roomSections(rooms, emptySet(), "me", null)
        assertEquals(listOf("c", "b", "a"), s.dms.map { it.id })
        assertEquals(listOf("p", "q", "r"), s.rooms.map { it.id })
    }

    @Test fun `rooms and DMs with unread messages first, each group in its usual order`() {
        val unread = mapOf("a" to 2, "r" to 1, "q" to 3)
        val s = roomSections(rooms, emptySet(), "me", null, unread)
        assertEquals(listOf("a", "c", "b"), s.dms.map { it.id })
        assertEquals(listOf("q", "r", "p"), s.rooms.map { it.id })
        // The open room keeps its place among the unread while it has unread messages left (2026-11-02).
        assertEquals(listOf("q", "r", "p"), roomSections(rooms, emptySet(), "me", "q", unread).rooms.map { it.id })
    }
}
