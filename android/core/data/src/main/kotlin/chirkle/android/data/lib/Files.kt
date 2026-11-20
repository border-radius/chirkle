// Attachment helpers (DESIGN.md §17.4, §17.5): web/src/lib/files.ts.
package chirkle.android.data.lib

import chirkle.android.data.model.Message
import java.util.Locale

private val IMAGE_EXT = setOf("jpg", "jpeg", "png", "gif", "webp", "avif")
private val VIDEO_EXT = setOf("mp4", "m4v", "webm", "mov", "ogv")
private val AUDIO_EXT = setOf("mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "weba")

private fun ext(name: String) = if ('.' in name) name.substringAfterLast('.').lowercase(Locale.ROOT) else ""

/** Shown inline as images (through server thumbnails, except GIFs and WebPs: see [showsItself]). */
fun isImage(name: String) = ext(name) in IMAGE_EXT

/**
 * A GIF's or a WebP's tile shows the file itself: the server's thumbnail is its first frame only. A still WebP is turned
 * into JPEG (PNG if transparent) before upload (§15.3), so a WebP is mostly an animated one. web/src/lib/files.ts showsItself.
 */
fun showsItself(name: String) = ext(name) == "gif" || ext(name) == "webp"

fun isVideo(name: String) = ext(name) in VIDEO_EXT

fun isAudio(name: String) = ext(name) in AUDIO_EXT

/** Shown inline (an image or a video) rather than as a download chip. */
fun isMedia(name: String) = isImage(name) || isVideo(name)

private val STORED_SUFFIX = Regex("_[a-zA-Z0-9]{10}(\\.[^.]*)?$")

/** "report_k3j2h1g0f9.pdf" → "report.pdf": PocketBase adds "_" and 10 random characters to stored names. */
fun displayName(stored: String): String = stored.replace(STORED_SUFFIX) { it.groupValues[1] }

/** What to call a message's attachment: its original upload name when the server recorded it (QA BUG-28). */
fun Message.attachmentName(stored: String): String = fileNames[stored]?.takeIf { it.isNotEmpty() } ?: displayName(stored)

/**
 * May a picked or shared file be read into a message? Only another app's content (`content://`, an authority not of
 * [ownPackage]): a `file://` URI, or one of this app's own providers, is opened with the app's own rights, so another
 * app could share the app's database and have it sent to a room (QA BUG-175).
 */
fun isForeignContent(scheme: String?, authority: String?, ownPackage: String): Boolean =
    scheme.equals("content", ignoreCase = true) && !authority.isNullOrEmpty() &&
        authority != ownPackage && !authority.startsWith("$ownPackage.")

fun formatBytes(n: Long): String = when {
    n < 1024 -> "$n B"
    n < 1024 * 1024 -> "${Math.round(n / 1024.0)} KB"
    else -> String.format(Locale.ROOT, "%.1f", n / 1024.0 / 1024.0).removeSuffix(".0") + " MB"
}

data class FileCheck<T>(val accepted: List<T>, val rejected: List<Pair<String, String>>)

/** Which of [added] fit next to [existing] files: at most 10 per message, each at most 20 MB. */
fun <T> checkFiles(existing: Int, added: List<T>, name: (T) -> String, size: (T) -> Long): FileCheck<T> {
    val accepted = mutableListOf<T>()
    val rejected = mutableListOf<Pair<String, String>>()
    for (f in added) {
        when {
            size(f) > Limits.ATTACHMENT_BYTES -> rejected += name(f) to Strings.largerThan(formatBytes(Limits.ATTACHMENT_BYTES))
            existing + accepted.size >= Limits.ATTACHMENTS -> rejected += name(f) to Strings.atMostFilesPerMessage(Limits.ATTACHMENTS)
            else -> accepted += f
        }
    }
    return FileCheck(accepted, rejected)
}
