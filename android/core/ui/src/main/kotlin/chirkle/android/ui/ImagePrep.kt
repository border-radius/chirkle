// Image preparation before upload (DESIGN.md §15.3; web/src/lib/image.ts): scaled so the longest edge is at most
// maxEdge (512 px for avatars, 2048 for attachments) and re-encoded, PNG as PNG and the rest as JPEG, which drops EXIF
// (GPS location). GIFs and animated WebPs stay as they are (re-encoding drops the animation); anything that fails stays
// as it was.
package chirkle.android.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.os.Build
import java.io.File

object ImagePrep {
    const val AVATAR_EDGE = 512
    const val ATTACHMENT_EDGE = 2048
    private val REENCODE = setOf("image/jpeg", "image/png", "image/webp")

    /** The size of a w×h image scaled down (never up) so its longest edge is at most [maxEdge]. */
    fun fitWithin(w: Int, h: Int, maxEdge: Int): Pair<Int, Int> {
        val scale = minOf(1.0, maxEdge.toDouble() / maxOf(w, h, 1))
        return maxOf(1, Math.round(w * scale).toInt()) to maxOf(1, Math.round(h * scale).toInt())
    }

    /**
     * Is [head] (a file's first bytes, at least 21) an animated WebP? An extended WebP (a VP8X chunk first) says so in
     * its flags byte; a plain one (VP8 or VP8L) is one frame. web/src/lib/image.ts isAnimatedWebp.
     */
    fun isAnimatedWebp(head: ByteArray): Boolean {
        fun at(i: Int, s: String) = i + s.length <= head.size && s.indices.all { head[i + it] == s[it].code.toByte() }
        return at(0, "RIFF") && at(8, "WEBP") && at(12, "VP8X") && head.size > 20 && (head[20].toInt() and 0x02) != 0
    }

    private fun animatedWebp(file: File): Boolean {
        val head = ByteArray(32)
        val n = file.inputStream().use { it.read(head) }
        return n > 20 && isAnimatedWebp(head.copyOf(n))
    }

    /**
     * [file] (of [type]) prepared into a new file next to it, or null to send it as it is. Returns the new file, its
     * name and type.
     */
    fun prepare(file: File, name: String, type: String, maxEdge: Int): Triple<File, String, String>? {
        if (type !in REENCODE) return null
        return runCatching {
            // A Bitmap is one frame: an animated WebP would become a still JPEG.
            if (type == "image/webp" && animatedWebp(file)) return null
            val bitmap = decode(file, maxEdge) ?: return null
            val (w, h) = fitWithin(bitmap.width, bitmap.height, maxEdge)
            val scaled = if (w == bitmap.width && h == bitmap.height) bitmap else Bitmap.createScaledBitmap(bitmap, w, h, true)
            val png = type == "image/png"
            val outName = when {
                png && name.endsWith(".png", true) -> name
                !png && (name.endsWith(".jpg", true) || name.endsWith(".jpeg", true)) -> name
                else -> name.substringBeforeLast('.').ifEmpty { "image" } + if (png) ".png" else ".jpg"
            }
            val out = File(file.parentFile, "prepared-$outName")
            out.outputStream().use { scaled.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 85, it) }
            Triple(out, outName, if (png) "image/png" else "image/jpeg")
        }.getOrNull()
    }

    /** Decoded about at size, upright: ImageDecoder applies the EXIF orientation (Android 9+). */
    private fun decode(file: File, maxEdge: Int): Bitmap? {
        if (Build.VERSION.SDK_INT >= 28) {
            return ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { d, info, _ ->
                val (w, h) = fitWithin(info.size.width, info.size.height, maxEdge)
                d.setTargetSize(w, h)
                d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        }
        return decodeLegacy(file, maxEdge)
    }

    /** Before Android 9: BitmapFactory, sampled down near [maxEdge], turned upright. Public for its test. */
    fun decodeLegacy(file: File, maxEdge: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxEdge) sample *= 2
        val bitmap = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        // BitmapFactory ignores the EXIF orientation, and the re-encoded file has none: a portrait photo would go
        // sideways (Android 8). Turned upright here, as ImageDecoder does.
        val m = orientation(runCatching { androidx.exifinterface.media.ExifInterface(file.path).getAttributeInt(androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION, 1) }.getOrDefault(1))
            ?: return bitmap
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, m, true)
    }

    /** The turn (and mirror) that makes an image with EXIF orientation [o] upright; null when it already is. */
    private fun orientation(o: Int): android.graphics.Matrix? {
        val m = android.graphics.Matrix()
        when (o) {
            2 -> m.setScale(-1f, 1f)
            3 -> m.setRotate(180f)
            4 -> m.setScale(1f, -1f)
            5 -> { m.setRotate(90f); m.postScale(-1f, 1f) }
            6 -> m.setRotate(90f)
            7 -> { m.setRotate(-90f); m.postScale(-1f, 1f) }
            8 -> m.setRotate(-90f)
            else -> return null
        }
        return m
    }
}
