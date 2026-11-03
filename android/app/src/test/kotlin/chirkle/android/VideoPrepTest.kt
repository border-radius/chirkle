package chirkle.android

import chirkle.android.feature.room.VideoPrep
import chirkle.android.feature.room.VideoPrep.Plan
import org.junit.Assert.assertEquals
import org.junit.Test

/** What VideoPrep does to a video before it is sent, by its size, length and bitrate. */
class VideoPrepTest {
    private val mb = 1024L * 1024

    @Test
    fun `a phone's 1080p video is encoded at 720p and 2 Mbit per s`() {
        assertEquals(Plan.Encode(720, 2_000_000), VideoPrep.plan(1920, 1080, 30_000, 17_000_000, 64 * mb))
        // Portrait: the short side is the width.
        assertEquals(Plan.Encode(720, 2_000_000), VideoPrep.plan(1080, 1920, 30_000, 17_000_000, 64 * mb))
    }

    @Test
    fun `a small video is only remuxed`() {
        assertEquals(Plan.Remux, VideoPrep.plan(1280, 720, 30_000, 1_500_000, 6 * mb))
        assertEquals(Plan.Remux, VideoPrep.plan(640, 360, 10_000, 800_000, 1 * mb))
    }

    @Test
    fun `a 720p video at a high bitrate is encoded at its size`() {
        assertEquals(Plan.Encode(null, 2_000_000), VideoPrep.plan(1280, 720, 30_000, 8_000_000, 30 * mb))
    }

    @Test
    fun `a long video gets the bitrate that fits the limit, and 480p below 1 Mbit per s`() {
        // 3 minutes: 20 MB × 8 × 0.9 / 180 s − 192 kbit/s.
        val fits = (20 * mb * 8 * 0.9 / 180 - 192_000).toInt()
        assertEquals(Plan.Encode(480, fits), VideoPrep.plan(1920, 1080, 180_000, 17_000_000, 380 * mb))
        // Over the limit even at a low bitrate: encoded, not remuxed.
        assertEquals(Plan.Encode(null, fits), VideoPrep.plan(854, 480, 180_000, 1_500_000, 32 * mb))
    }

    @Test
    fun `a video too long for the limit isn't sent`() {
        assertEquals(Plan.TooLong, VideoPrep.plan(1920, 1080, 10 * 60_000, 17_000_000, 1200 * mb))
        assertEquals(4, VideoPrep.maxMinutes())
    }

    @Test
    fun `the result is named as an MP4`() {
        assertEquals("clip.mp4", VideoPrep.mp4Name("clip.MOV"))
        assertEquals("a.b.mp4", VideoPrep.mp4Name("a.b.webm"))
        assertEquals("video.mp4", VideoPrep.mp4Name(".mov"))
    }
}
