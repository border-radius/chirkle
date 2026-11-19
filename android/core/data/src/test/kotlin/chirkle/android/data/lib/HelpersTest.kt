package chirkle.android.data.lib

import chirkle.android.data.model.Message
import chirkle.android.data.model.Reaction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

// Reactions, avatars and attachment helpers: the cases of tests/unit/lib/{reactions,avatar,files}.test.ts.
class HelpersTest {
    private val list = listOf(Reaction("👍", listOf("a", "b")), Reaction("🎉", listOf("b")))

    @Test fun `setReaction adds to an emoji, or adds the emoji last`() {
        assertEquals(listOf(Reaction("👍", listOf("a", "b", "c")), Reaction("🎉", listOf("b"))), setReaction(list, "👍", "c", true))
        assertEquals(list + Reaction("❤️", listOf("a")), setReaction(list, "❤️", "a", true))
    }

    @Test fun `setReaction removes, dropping an emoji nobody uses`() {
        assertEquals(listOf(Reaction("👍", listOf("b")), Reaction("🎉", listOf("b"))), setReaction(list, "👍", "a", false))
        assertEquals(listOf(Reaction("👍", listOf("a", "b"))), setReaction(list, "🎉", "b", false))
    }

    @Test fun `setReaction returns the same list when nothing changes`() {
        assertSame(list, setReaction(list, "👍", "a", true))
        assertSame(list, setReaction(list, "🎉", "a", false))
        assertSame(list, setReaction(list, "❤️", "a", false))
    }

    private val names = mapOf("a" to "Ada", "b" to "Bob", "c" to "Cy", "d" to "Di", "e" to "Ed", "f" to "Flo", "g" to "Gus")::get

    @Test fun `reactors names who reacted, you first, and counts the rest`() {
        assertEquals("You", reactors(listOf("me"), "me", names))
        assertEquals("You and Ada", reactors(listOf("a", "me"), "me", names))
        assertEquals("Ada, Bob and Cy", reactors(listOf("a", "b", "c"), "me", names))
        assertEquals("Ada and 1 other", reactors(listOf("a", "x"), "me", names))
        assertEquals("Ada and 2 others", reactors(listOf("a", "x", "y"), "me", names))
        assertEquals("1 person", reactors(listOf("x"), "me", names))
        assertEquals("2 people", reactors(listOf("x", "y"), "me", names))
        assertEquals("Ada, Bob, Cy, Di, Ed and 2 others", reactors(listOf("a", "b", "c", "d", "e", "f", "g"), "me", names))
    }

    @Test fun `initials take the first letter of two words, keeping graphemes whole`() {
        assertEquals("A", initials("ada"))
        assertEquals("AL", initials("Ada Lovelace"))
        assertEquals("GB", initials("  grace   brewster murray hopper "))
        assertEquals("👩‍💻D", initials("👩‍💻 dev"))
        assertEquals("ÉZ", initials("émile zola"))
        assertEquals("?", initials("   "))
    }

    @Test fun `initials leave out a label in brackets and punctuation before a word (QA BUG-176)`() {
        assertEquals("A", initials("Ann (B)"))
        assertEquals("AL", initials("Ann Lee (TG)"))
        assertEquals("A2", initials("Ann 2 (c.example)"))
        assertEquals("B", initials("“Bob” (B)"))
        assertEquals("?", initials("(B)"))
    }

    @Test fun `avatar colours spread over the palette and match the web's`() {
        val used = (0 until 200).map { avatarColor("user" + it.toString(36).padStart(10, '0')) }.toSet()
        assertEquals(AVATAR_COLORS, used.size)
        // As the web computes them (web/src/lib/avatar.ts): FNV-1a of "x" is 0xfd0c5087.
        assertEquals(7, avatarColor("x"))
        assertEquals(7, avatarColor("abc123def456ghi"))
    }

    @Test fun `displayName strips PocketBase's random suffix`() {
        assertEquals("report.pdf", displayName("report_k3j2h1g0f9.pdf"))
        assertEquals("my_holiday_photo.jpeg", displayName("my_holiday_photo_abcdefghij.jpeg"))
        assertEquals("README", displayName("README_0123456789"))
        assertEquals("plain.txt", displayName("plain.txt"))
        assertEquals("short_abc.txt", displayName("short_abc.txt"))
        val stored = "quarterly_report_final_k3j2h1g0f9.pdf"
        assertEquals("Quarterly Report (final).pdf", Message("m", "r", fileNames = mapOf(stored to "Quarterly Report (final).pdf")).attachmentName(stored))
        assertEquals("quarterly_report_final.pdf", Message("m", "r").attachmentName(stored))
    }

    @Test fun `file kinds go by extension`() {
        for (n in listOf("a.jpg", "a.JPEG", "a.png", "a.gif", "a.webp", "a.avif")) assertTrue(n, isImage(n))
        for (n in listOf("a.svg", "a.pdf", "a.html", "png", "a.png.exe")) assertFalse(n, isImage(n))
        for (n in listOf("a.mp3", "a.MP3", "a.m4a", "a.opus", "a.weba")) assertTrue(n, isAudio(n))
        for (n in listOf("a.ogv", "a.mp4", "mp3")) assertFalse(n, isAudio(n))
        for (n in listOf("a.mp4", "a.MOV", "a.webm", "a.ogv")) assertTrue(n, isVideo(n))
        for (n in listOf("a.avi", "a.mkv", "mp4")) assertFalse(n, isVideo(n))
        for (n in listOf("a.GIF", "a.webp", "a.WEBP")) assertTrue(n, showsItself(n))
        for (n in listOf("a.gif.exe", "a.png", "a.webp.exe")) assertFalse(n, showsItself(n))
    }

    @Test fun `only other apps' content is read into a message (QA BUG-175)`() {
        val me = "com.chirkle.android"
        assertTrue(isForeignContent("content", "com.android.providers.media.documents", me))
        assertTrue(isForeignContent("CONTENT", "com.chirkle.androidx.other", me))
        assertFalse(isForeignContent("file", "", me))
        assertFalse(isForeignContent("file", null, me))
        assertFalse(isForeignContent(null, null, me))
        assertFalse(isForeignContent("content", null, me))
        assertFalse(isForeignContent("content", me, me))
        assertFalse(isForeignContent("content", "$me.androidx-startup", me))
        assertFalse(isForeignContent("content", "com.chirkle.android.debug.files", "com.chirkle.android.debug"))
    }

    @Test fun `formatBytes and checkFiles`() {
        assertEquals("512 B", formatBytes(512))
        assertEquals("2 KB", formatBytes(2048))
        assertEquals("8 MB", formatBytes(8L * 1024 * 1024))
        assertEquals("1.5 MB", formatBytes(1536L * 1024))
        val res = checkFiles(9, listOf("10" to 1L, "big.bin" to 20L * 1024 * 1024 + 1, "11" to 1L), { it.first }, { it.second })
        assertEquals(listOf("10"), res.accepted.map { it.first })
        assertEquals(listOf("big.bin" to "larger than 20 MB", "11" to "at most 10 files per message"), res.rejected)
    }

    @Test fun `ids are 15 characters of a-z0-9`() {
        repeat(100) { assertTrue(Regex("[a-z0-9]{15}").matches(newId())) }
    }

    @Test fun `PocketBase datetimes round-trip`() {
        val s = "2026-10-10 12:34:56.789Z"
        assertEquals(s, toPb(parsePb(s)))
        assertEquals(Long.MIN_VALUE, parsePb(""))
    }
}
