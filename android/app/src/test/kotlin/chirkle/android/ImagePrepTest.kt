package chirkle.android

import android.graphics.Bitmap
import android.graphics.Color
import androidx.exifinterface.media.ExifInterface
import chirkle.android.ui.ImagePrep
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.GraphicsMode

// Photos are re-encoded before upload (DESIGN.md §15.3), which drops their EXIF: they must be upright first.
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ImagePrepTest {
    @get:Rule val tmp = TemporaryFolder()

    /** A 40×20 JPEG, its left half red, saying it must be turned a quarter clockwise (a phone held upright). */
    private fun photo(orientation: Int) = tmp.newFile("photo-$orientation.jpg").also { f ->
        val b = Bitmap.createBitmap(40, 20, Bitmap.Config.ARGB_8888)
        for (x in 0 until 40) for (y in 0 until 20) b.setPixel(x, y, if (x < 20) Color.RED else Color.BLUE)
        f.outputStream().use { b.compress(Bitmap.CompressFormat.JPEG, 95, it) }
        ExifInterface(f.path).apply { setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString()); saveAttributes() }
    }

    private fun red(c: Int) = Color.red(c) > 200 && Color.blue(c) < 80

    @Test fun `before Android 9 a photo is turned upright as its EXIF says`() {
        val b = ImagePrep.decodeLegacy(photo(ExifInterface.ORIENTATION_ROTATE_90), 2048)!!
        assertEquals(20, b.width)
        assertEquals(40, b.height)
        // A quarter turn clockwise: the left half is now the top.
        assertTrue(red(b.getPixel(10, 5)))
        assertTrue(!red(b.getPixel(10, 35)))
    }

    @Test fun `an upright photo stays as it is`() {
        val b = ImagePrep.decodeLegacy(photo(ExifInterface.ORIENTATION_NORMAL), 2048)!!
        assertEquals(40, b.width)
        assertTrue(red(b.getPixel(5, 10)))
    }

    /** The first bytes of a WebP: an extended one (VP8X) with these flags, or a plain lossy one (flags null). */
    private fun webpHead(flags: Int?) = ByteArray(32).also { b ->
        fun put(i: Int, s: String) = s.forEachIndexed { k, c -> b[i + k] = c.code.toByte() }
        put(0, "RIFF"); put(8, "WEBP"); put(12, if (flags == null) "VP8 " else "VP8X")
        if (flags != null) b[20] = flags.toByte()
    }

    @Test fun `an animated WebP is told by its VP8X flags`() {
        assertTrue(ImagePrep.isAnimatedWebp(webpHead(0x02)))
        assertTrue(ImagePrep.isAnimatedWebp(webpHead(0x12)))
        assertTrue(!ImagePrep.isAnimatedWebp(webpHead(0x10)))
        assertTrue(!ImagePrep.isAnimatedWebp(webpHead(null)))
        assertTrue(!ImagePrep.isAnimatedWebp(ByteArray(4)))
    }

    @Test fun `an animated WebP is sent as it is`() {
        val f = tmp.newFile("dance.webp").apply { writeBytes(webpHead(0x02)) }
        assertEquals(null, ImagePrep.prepare(f, "dance.webp", "image/webp", 2048))
    }
}
