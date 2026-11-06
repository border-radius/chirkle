package chirkle.android.data.lib

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// The app offers exactly the emoji the server accepts as reactions (§20.1): pb_hooks/lib/emoji.js, line by line.
class EmojiTest {
    @Test fun `matches the server's list, category by category`() {
        val js = File(System.getProperty("chirkle.repoRoot"), "pb_hooks/lib/emoji.js").readText()
        val lines = Regex("^  \"([^\"]+)\",$", RegexOption.MULTILINE).findAll(js).map { it.groupValues[1] }.toList()
        assertEquals(EMOJI_CATEGORIES.map { it.emoji.joinToString(" ") }, lines)
    }

    @Test fun `quick reactions are among them`() {
        for (e in QUICK_REACTIONS) assertTrue(e, e in EMOJI)
    }

    // Emoji by name (DESIGN.md §20.6): the web's lines and its unit cases (tests/unit/lib/emoji.test.ts, emoji-suggest.test.ts).
    @Test fun `names are the web's, line by line, one per picker emoji`() {
        val ts = File(System.getProperty("chirkle.repoRoot"), "web/src/lib/emoji-names.ts").readText()
        val lines = Regex("export const NAMES = `([^`]*)`").find(ts)!!.groupValues[1].lines()
        assertEquals(lines, EMOJI_NAMES.map { (listOf(it.emoji) + lines.first { l -> l.startsWith(it.emoji + " ") }.split(' ').drop(1)).joinToString(" ") })
        assertEquals(EMOJI.toList(), EMOJI_NAMES.map { it.emoji })
        assertEquals(EMOJI_NAMES.size, EMOJI_NAMES.map { it.name }.toSet().size)
    }

    @Test fun `finds by the beginnings of words, exact names first, then shorter names beginning so`() {
        assertEquals("🔥", findEmoji("fire")[0].emoji)
        assertEquals(listOf("🔥", "🎆"), findEmoji("fir").take(2).map { it.emoji })
        assertEquals("❤️", findEmoji("heart")[0].emoji)
        assertEquals("😍", findEmoji("heart_e")[0].emoji)
        assertTrue("😍" in findEmoji("eyes").map { it.emoji })
        assertEquals(listOf("👍"), findEmoji("Thumbs UP").map { it.emoji })
        assertEquals(listOf("👍"), findEmoji("+1").map { it.emoji })
        assertEquals(3, findEmoji("smile", 3).size)
        assertEquals(emptyList<NamedEmoji>(), findEmoji("  "))
        assertEquals("🎉", emojiNamed("TADA"))
        assertNull(emojiNamed("tad"))
    }

    @Test fun `a name being typed is a colon and two characters, not a time, a link or a smiley`() {
        fun at(t: String) = emojiToken(t, t.length)?.let { it.start to it.query }
        assertEquals(0 to "th", at(":th"))
        assertEquals(3 to "fire", at("so :Fire"))
        assertEquals(1 to "+1", at("(:+1"))
        assertEquals(0 to "tada", emojiToken(":tada more", 5)?.let { it.start to it.query })
        for (t in listOf("12:30", "http://x", "a:bc", ":)", ":D", ":t", ":ta ", "", ":ta\n")) assertNull(t, at(t))
        assertEquals(5 to "🎉", wholeEmojiName("nice :tada:", 11))
        assertNull(wholeEmojiName("nice :nope:", 11))
    }
}
