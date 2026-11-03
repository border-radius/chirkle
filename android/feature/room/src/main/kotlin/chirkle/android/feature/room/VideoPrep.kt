// Video preparation before upload (ANDROID.md §46), as ImagePrep is for photos: every video goes through Media3's
// Transformer into an MP4 without its metadata (the GPS location phones write). One too big for its length (more than
// 720p, or a high bitrate: a phone's 1080p is about 17 Mbit/s) is re-encoded as H.264 at most 720p and 30 fps, at a
// bitrate that also fits the 20 MB limit; the rest is only remuxed, which is fast. Anything that fails stays as it was.
package chirkle.android.feature.room

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import androidx.annotation.OptIn
import androidx.media3.common.Format
import androidx.media3.common.Metadata
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.Presentation
import androidx.media3.muxer.BufferInfo
import androidx.media3.muxer.Muxer
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.DefaultMuxer
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import chirkle.android.data.lib.Limits
import java.io.File
import java.nio.ByteBuffer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

object VideoPrep {
    const val SHORT_SIDE = 720
    /** The short side when the bitrate has to go below [LOW_BITRATE] to fit a long video into the limit. */
    const val SHORT_SIDE_LOW = 480
    const val VIDEO_BITRATE = 2_000_000
    const val LOW_BITRATE = 1_000_000
    /** Below this a video would be mush: one that needs less to fit isn't sent. */
    const val MIN_BITRATE = 400_000
    /** Room left for the audio (kept as it is when it is AAC: up to 192 kbit/s on phones) and the container. */
    const val AUDIO_ALLOWANCE = 192_000
    /** Picked videos up to this size are taken (the result must still be under [Limits.ATTACHMENT_BYTES]). */
    const val MAX_SOURCE_BYTES = 4L * 1024 * 1024 * 1024

    /** What is done to a video: [Remux] (only the metadata goes) or [Encode] at this short side and bitrate. */
    sealed interface Plan {
        data object Remux : Plan
        data class Encode(val shortSide: Int?, val bitrate: Int) : Plan
        /** Too long to fit the limit at [MIN_BITRATE]. */
        data object TooLong : Plan
    }

    /**
     * The plan for a [w]×[h] video of [durationMs] and [bytes] ([bitrate] bit/s, overall). Its video gets the bitrate
     * that fits [limit] (90% of it, for the audio and the container), at most [VIDEO_BITRATE].
     */
    fun plan(w: Int, h: Int, durationMs: Long, bitrate: Long, bytes: Long, limit: Long = Limits.ATTACHMENT_BYTES): Plan {
        val seconds = durationMs / 1000.0
        val fits = if (seconds > 0) (limit * 8 * 0.9 / seconds - AUDIO_ALLOWANCE).toLong() else VIDEO_BITRATE.toLong()
        val target = minOf(VIDEO_BITRATE.toLong(), fits)
        val short = minOf(w, h)
        val side = if (target < LOW_BITRATE) SHORT_SIDE_LOW else SHORT_SIDE
        val small = short in 1..side && bitrate in 1..(target * 5 / 4 + AUDIO_ALLOWANCE) && bytes <= limit
        return when {
            small -> Plan.Remux
            target < MIN_BITRATE -> Plan.TooLong
            else -> Plan.Encode(if (short > side) side else null, target.toInt())
        }
    }

    /** About the longest video that fits [limit] at [MIN_BITRATE], in whole minutes. */
    fun maxMinutes(limit: Long = Limits.ATTACHMENT_BYTES) = (limit * 8 * 0.9 / (MIN_BITRATE + AUDIO_ALLOWANCE) / 60).toInt()

    /** The name of [name] as an MP4. */
    fun mp4Name(name: String) = name.substringBeforeLast('.').ifEmpty { "video" } + ".mp4"

    sealed interface Result {
        /** Prepared into [file]: send it as video/mp4 named [name]. */
        data class Done(val file: File, val name: String) : Result
        /** Couldn't be read or written: send the original, as before (when it isn't too big). */
        data object Failed : Result
        data object TooLong : Result
    }

    /**
     * [uri] (a video named [name], [bytes] long) prepared into [out]. [onProgress] gets 0..100 now and then, on the
     * main thread. Cancelling stops the export (and [out] goes).
     */
    @OptIn(UnstableApi::class)
    suspend fun prepare(context: Context, uri: Uri, name: String, bytes: Long, out: File, onProgress: (Int) -> Unit = {}): Result {
        val plan = withContext(Dispatchers.IO) { probe(context, uri, bytes) } ?: return Result.Failed
        if (plan == Plan.TooLong) return Result.TooLong
        val encode = plan as? Plan.Encode
        val item = EditedMediaItem.Builder(MediaItem.fromUri(uri))
            .apply {
                if (encode != null) {
                    val effects = listOfNotNull(encode.shortSide?.let { Presentation.createForShortSide(it) }, FrameDropEffect.createDefaultFrameDropEffect(30f))
                    setEffects(Effects(emptyList(), effects))
                }
            }
            .build()
        val composition = Composition.Builder(EditedMediaItemSequence.Builder(item).build())
            .apply {
                if (encode == null) {
                    setTransmuxVideo(true)
                    setTransmuxAudio(true)
                } else if (Build.VERSION.SDK_INT >= 29) {
                    // HDR from the camera would stay HDR (10-bit HEVC); SDR H.264 plays everywhere.
                    setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)
                }
            }
            .build()
        return try {
            val error = withContext(Dispatchers.Main) { export(context, composition, encode?.bitrate, out, onProgress) }
            if (error == null && out.length() > 0) Result.Done(out, mp4Name(name)) else Result.Failed.also { out.delete() }
        } catch (e: CancellationException) {
            out.delete()
            throw e
        }
    }

    /** The plan for the video at [uri], or null when it can't be read. */
    private fun probe(context: Context, uri: Uri, bytes: Long): Plan? = runCatching {
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(context, uri)
            fun int(key: Int) = r.extractMetadata(key)?.toLongOrNull() ?: 0L
            val w = int(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH).toInt()
            val h = int(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT).toInt()
            val duration = int(MediaMetadataRetriever.METADATA_KEY_DURATION)
            if (w <= 0 || h <= 0) return null
            val bitrate = int(MediaMetadataRetriever.METADATA_KEY_BITRATE).takeIf { it > 0 }
                ?: if (duration > 0 && bytes > 0) bytes * 8 * 1000 / duration else 0
            plan(w, h, duration, bitrate, bytes)
        } finally {
            r.release()
        }
    }.getOrNull()

    /** Runs the export on the main thread (Transformer's); the error, or null when it is done. */
    @OptIn(UnstableApi::class)
    private suspend fun export(context: Context, composition: Composition, bitrate: Int?, out: File, onProgress: (Int) -> Unit): ExportException? {
        val done = CompletableDeferred<ExportException?>()
        val encoders = DefaultEncoderFactory.Builder(context)
            .apply { bitrate?.let { setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(it).build()) } }
            .build()
        val transformer = Transformer.Builder(context)
            .setVideoMimeType(MimeTypes.VIDEO_H264)
            .setAudioMimeType(MimeTypes.AUDIO_AAC)
            .setEncoderFactory(encoders)
            .setMuxerFactory(NoMetadata(DefaultMuxer.Factory()))
            .addListener(object : Transformer.Listener {
                override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                    done.complete(null)
                }

                override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                    done.complete(exportException)
                }
            })
            .build()
        out.delete()
        transformer.start(composition, out.path)
        return kotlinx.coroutines.coroutineScope {
            val poll = launch {
                val holder = ProgressHolder()
                while (true) {
                    delay(250)
                    if (transformer.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) onProgress(holder.progress)
                }
            }
            try {
                done.await()
            } catch (e: CancellationException) {
                transformer.cancel()
                throw e
            } finally {
                poll.cancel()
            }
        }
    }

    /** The muxer without the source's metadata entries (location, capture details); the rotation is the track's. */
    @OptIn(UnstableApi::class)
    private class NoMetadata(private val factory: Muxer.Factory) : Muxer.Factory by factory {
        override fun create(path: String): Muxer {
            val muxer = factory.create(path)
            return object : Muxer {
                override fun addTrack(format: Format) = muxer.addTrack(format)
                override fun writeSampleData(trackId: Int, data: ByteBuffer, bufferInfo: BufferInfo) = muxer.writeSampleData(trackId, data, bufferInfo)
                override fun addMetadataEntry(metadataEntry: Metadata.Entry) {}
                override fun close() = muxer.close()
            }
        }
    }
}
