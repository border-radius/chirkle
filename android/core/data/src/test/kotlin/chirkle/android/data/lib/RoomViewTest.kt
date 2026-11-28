package chirkle.android.data.lib

import chirkle.android.data.model.Message
import chirkle.android.data.model.MessageExpand
import chirkle.android.data.model.User
import org.junit.Assert.assertEquals
import org.junit.Test

// The room view redesign (2026-11-23, ANDROID.md §89): the scroll button's faces (web/src/views/room.ts `renderPill`)
// and the preview line's site (messages.ts `siteOf`).
class RoomViewTest {
    private fun msg(id: String, author: String) = Message(id, "r", author = author, expand = MessageExpand(author = User(author, author.uppercase())))

    @Test fun `the newest three authors after the last one seen, not you, each once, oldest first`() {
        val items = listOf(msg("1", "a"), msg("2", "b"), msg("3", "me"), msg("4", "c"), msg("5", "b"), msg("6", "d"), msg("7", "c"))
        assertEquals(listOf("b", "d", "c"), pillFaces(items, "1", "me").map { it.id })
        assertEquals(listOf("d", "c"), pillFaces(items, "5", "me").map { it.id })
        assertEquals(emptyList<String>(), pillFaces(items, "7", "me").map { it.id })
        // Gone from the window: all of it counts.
        assertEquals(listOf("b", "d", "c"), pillFaces(items, "gone", "me").map { it.id })
    }

    @Test fun `a site is its host without www`() {
        assertEquals("example.com", siteOf("https://www.Example.com/a?b"))
        assertEquals("news.example.org", siteOf("http://news.example.org"))
        assertEquals("", siteOf("not a url"))
    }
}
