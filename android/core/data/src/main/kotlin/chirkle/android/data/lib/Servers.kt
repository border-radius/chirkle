// Server addresses (ANDROID.md §17.2, §17.3): what someone types or pastes, made into the address the app uses, and
// which server a link belongs to.
package chirkle.android.data.lib

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Why an address can't be used: shown under the field as it is. */
class ServerProblem(message: String) : Exception(message)

/**
 * The server [input] means, as `scheme://host[:port][/path]` without a trailing slash: https when no scheme is given,
 * and the server of a pasted room link (`/r/…`), admin link (`/_/…`) or API URL. [allowHttp]: debug builds only.
 */
fun serverAddress(input: String, allowHttp: Boolean): String {
    val raw = input.trim()
    if (raw.isEmpty()) throw ServerProblem(Strings.ENTER_YOUR_SERVERS_ADDRESS)
    val withScheme = if ("://" in raw) raw else "https://$raw"
    val url = withScheme.toHttpUrlOrNull() ?: throw ServerProblem(Strings.THAT_ISNT_A_WEB_ADDRESS)
    if (url.scheme == "http" && !allowHttp) throw ServerProblem(Strings.USE_AN_HTTPS_ADDRESS)
    val path = url.pathSegments.takeWhile { it !in APP_PATHS }.filter { it.isNotEmpty() }
    return url.newBuilder().query(null).fragment(null).username("").password("")
        .encodedPath("/" + path.joinToString("/") { it.encodeSegment() }).build().toString().trimEnd('/')
}

/** How an address is shown: without its scheme (`chat.example.org`, `10.0.2.2:8090`). */
fun serverLabel(server: String): String = server.substringAfter("://")

/**
 * The path of [url] under [server] (`["r", id]` for `server/r/id`), or null when the link isn't that server's. The
 * scheme doesn't count: an http link to an https server is the same server.
 */
fun pathOnServer(server: String, url: String): List<String>? {
    val s = server.toHttpUrlOrNull() ?: return null
    val u = url.toHttpUrlOrNull() ?: return null
    if (u.host != s.host || u.effectivePort() != s.effectivePort()) return null
    val prefix = s.pathSegments.filter { it.isNotEmpty() }
    val segs = u.pathSegments.filter { it.isNotEmpty() }
    if (segs.size < prefix.size || segs.subList(0, prefix.size) != prefix) return null
    return segs.drop(prefix.size)
}

/** The port, with the default ports of http and https counting as one ("no port given"). */
private fun HttpUrl.effectivePort(): Int = if (port == HttpUrl.defaultPort(scheme)) -1 else port

private fun String.encodeSegment(): String = HttpUrl.Builder().scheme("https").host("x").addPathSegment(this).build().encodedPath.drop(1)

/** The app's own paths: what follows them isn't part of the server's address. */
private val APP_PATHS = setOf("r", "c", "_", "api")
