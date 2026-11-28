package chirkle.android.data.lib

import chirkle.android.data.model.MediaCollection
import chirkle.android.data.model.Room
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The sidebar improvements (2026-11-23, -24): tests/component/views/rooms.test.ts's taken names, dots and counts, and
// ui/user-search.ts's bold match.
class SidebarTest {
    @Test fun `names compare as the server compares them on create`() {
        assertEquals("design team", listedNameKey("  Design​   TEAM "))
        assertEquals("a b", listedNameKey("a\u0007b"))
        assertEquals("abc", listedNameKey("ＡＢＣ"))
        // Rooms: leading "#"s go too; collections keep them.
        assertEquals("general", listedNameKey("## General", room = true))
        assertEquals("#general", listedNameKey("#General"))
    }

    @Test fun `a room name is taken ignoring case and a leading hash, DMs aside`() {
        val rooms = listOf(Room("r1", "taken-1"), Room("d1", "dm-name", kind = "dm"))
        assertEquals("r1", takenRoom(rooms, "#TAKEN-1")?.id)
        assertEquals("r1", takenRoom(rooms, " taken-1 ")?.id)
        assertNull(takenRoom(rooms, "taken-2"))
        assertNull(takenRoom(rooms, "dm-name"))
        assertNull(takenRoom(rooms, " # "))
        assertEquals("taken-1", bareRoomName("##taken-1"))
    }

    @Test fun `a collection name is taken among yours`() {
        val mine = listOf(MediaCollection("c1", "Moodboard"))
        assertEquals("c1", takenCollection(mine, "moodboard")?.id)
        assertNull(takenCollection(mine, "Moodboard 2"))
        assertNull(takenCollection(mine, "  "))
    }

    @Test fun `numbers only for what is addressed to you, otherwise a dot`() {
        val room = Room("r", "a")
        val dm = Room("d", kind = "dm")
        assertEquals(UnreadMark.None, unreadMark(room, 0, 0))
        assertEquals(UnreadMark.Dot(1), unreadMark(room, 1, 0))
        assertEquals(UnreadMark.Count(2, mentions = true, unread = 5), unreadMark(room, 5, 2))
        assertEquals(UnreadMark.Count(3, mentions = false, unread = 3), unreadMark(dm, 3, 0))
        // Read (its count gone): nothing, whatever mentions said.
        assertEquals(UnreadMark.None, unreadMark(room, 0, 2))
    }

    @Test fun `the first place a search matches, ignoring case`() {
        assertEquals(0..2, matchRange("Maya Chen", "may"))
        assertEquals(5..8, matchRange("Maya Chen", "CHEN"))
        assertEquals(0..4, matchRange("@maya · On b.example", "@maya"))
        assertNull(matchRange("Maya", "sam"))
        assertNull(matchRange("Maya", ""))
        // Lowercasing that changes the length: no offsets to trust, so nothing in bold.
        assertNull(matchRange("İstanbul", "ist"))
    }
}
