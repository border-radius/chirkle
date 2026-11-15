// A minimal PocketBase client (ANDROID.md §6.1): REST requests with the auth header, parameter binding for filters,
// file URLs. A port of web/src/pb.ts; the realtime half is Realtime.kt. Calls suspend and are main-safe.
package chirkle.android.data.pb

import chirkle.android.data.lib.Strings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The JSON settings every decode uses: unknown fields ignored, nulls as defaults (PocketBase sends `null` for empty JSON). */
val PbJson = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    explicitNulls = false
    encodeDefaults = true
}

/**
 * A failed request. [status] is 0 for network trouble. [response] is PocketBase's error body:
 * `{ message, data: { field: { code, message } } }`.
 */
class PbError(val status: Int, val response: JsonObject = JsonObject(emptyMap()), cause: Throwable? = null) :
    IOException(response.str("message") ?: Strings.SOMETHING_WENT_WRONG, cause) {
    /** Per-field validation messages, e.g. email → "Must be a valid email." */
    val fields: Map<String, String> get() = data("message")
    /** Per-field validation codes, e.g. name → "validation_not_unique". Match on these, not on messages. */
    val codes: Map<String, String> get() = data("code")

    private fun data(key: String): Map<String, String> {
        val d = response["data"] as? JsonObject ?: return emptyMap()
        return d.mapNotNull { (k, v) -> ((v as? JsonObject)?.get(key) as? JsonPrimitive)?.contentOrNull?.let { k to it } }.toMap()
    }
}

internal fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

/** A file to upload in a multipart body. */
class UploadFile(val name: String, val type: String, val body: RequestBody)

/** A request body: JSON, or multipart when it holds files. */
sealed interface Body {
    class Json(val value: JsonObject) : Body

    /**
     * Fields as strings, files, and anything else as JSON in PocketBase's `@jsonPayload`. [onUpload] hears how much of
     * it has been sent, 0 to 1 (§17.4).
     */
    class Multipart(
        val fields: Map<String, String> = emptyMap(),
        val files: Map<String, List<UploadFile>> = emptyMap(),
        val json: JsonObject? = null,
        val onUpload: ((Float) -> Unit)? = null,
    ) : Body
}

class PbClient(baseUrl: String, val http: OkHttpClient, val authStore: AuthStore) {
    val base: HttpUrl = baseUrl.trimEnd('/').toHttpUrl()

    val realtime: Realtime by lazy { Realtime(this) }

    fun url(path: String, query: Map<String, Any?> = emptyMap()): HttpUrl {
        val b = base.newBuilder().encodedPath(base.encodedPath.trimEnd('/') + path)
        for ((k, v) in query) if (v != null) b.addQueryParameter(k, v.toString())
        return b.build()
    }

    /** Send a request; the answer's JSON, or [PbError]. Cancelling the coroutine cancels the call. */
    suspend fun send(
        path: String,
        method: String = "GET",
        query: Map<String, Any?> = emptyMap(),
        body: Body? = null,
    ): JsonElement {
        val request = Request.Builder().url(url(path, query)).apply {
            authStore.token.takeIf { it.isNotEmpty() }?.let { header("Authorization", it) }
            method(method, body?.toRequestBody() ?: if (method == "GET" || method == "DELETE") null else EMPTY_JSON)
        }.build()
        val response = try {
            http.newCall(request).await()
        } catch (e: IOException) {
            throw PbError(0, cause = e)
        }
        // Closed whatever happens, also when cancelled before readAnswer's block starts: an answer left unread holds its
        // connection, and OkHttp may hand it to another call with the old body still in front of the new status line
        // ("Unexpected status line: {…}HTTP/1.1 200 OK", which failed a later request at random).
        return try {
            readAnswer(response)
        } catch (e: kotlinx.coroutines.CancellationException) {
            response.close()
            throw e
        }
    }

    private suspend fun readAnswer(response: Response): JsonElement =
        withContext(Dispatchers.IO) {
            response.use {
                val text = try {
                    it.body.string()
                } catch (e: IOException) {
                    throw PbError(0, cause = e)
                }
                val parsed = if (text.isBlank()) null else runCatching { PbJson.parseToJsonElement(text) }.getOrNull()
                // No body is fine for a 204, or an error the server didn't explain. A success without one (a proxy's or a
                // captive portal's page, an answer cut short) is network trouble, not `{}`: as a login's or a renewal's
                // answer it would have saved no session, or crashed reading it (the web's QA BUG-117; BUG-158).
                if (parsed == null && it.code < 300 && it.code != 204) throw PbError(0)
                val json = parsed ?: JsonObject(emptyMap())
                if (it.code >= 400) throw PbError(it.code, json as? JsonObject ?: JsonObject(emptyMap()))
                json
            }
        }

    /**
     * Bind `{:name}` placeholders in a filter expression, quoting and escaping the values as `pb.filter()` does: a
     * value never becomes part of the expression (no filter injection).
     */
    fun filter(expr: String, params: Map<String, Any?>): String = PLACEHOLDER.replace(expr) { m ->
        val name = m.groupValues[1]
        if (!params.containsKey(name)) return@replace m.value
        when (val v = params[name]) {
            is String -> PbJson.encodeToString(JsonPrimitive.serializer(), JsonPrimitive(v))
            null -> "null"
            else -> v.toString()
        }
    }

    /** URL of a record's file (`thumb`, `token` in [query]). */
    fun fileUrl(collection: String, recordId: String, filename: String, query: Map<String, Any?> = emptyMap()): HttpUrl {
        val b = base.newBuilder().addPathSegments("api/files").addPathSegment(collection).addPathSegment(recordId).addPathSegment(filename)
        for ((k, v) in query) if (v != null) b.addQueryParameter(k, v.toString())
        return b.build()
    }

    private fun Body.toRequestBody(): RequestBody = when (this) {
        is Body.Json -> value.toString().toRequestBody(JSON_TYPE)
        is Body.Multipart -> {
            val mb = MultipartBody.Builder().setType(MultipartBody.FORM)
            for ((k, v) in fields) mb.addFormDataPart(k, v)
            json?.let { mb.addFormDataPart("@jsonPayload", it.toString()) }
            for ((k, list) in files) for (f in list) mb.addFormDataPart(k, f.name, f.body)
            val built = mb.build()
            onUpload?.let { ProgressBody(built, it) } ?: built
        }
    }

    private companion object {
        val JSON_TYPE = "application/json".toMediaType()
        val EMPTY_JSON = "{}".toRequestBody(JSON_TYPE)
        val PLACEHOLDER = Regex("\\{:(\\w+)\\}")
    }
}

/** The JSON object of an answer (every PocketBase answer but a list route's is one). */
val JsonElement.obj: JsonObject get() = jsonObject

suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (cont.isActive) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            // Cancelled after this resume but before the caller ran, the answer would be dropped unread: close it then.
            if (cont.isActive) cont.resume(response) { _, r, _ -> r.close() } else response.close()
        }
    })
}
