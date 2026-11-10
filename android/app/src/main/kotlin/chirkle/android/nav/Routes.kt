// Routes (ANDROID.md §7): they mirror the web's paths (DESIGN.md §7.1), so a link to a room or a message is a route.
package chirkle.android.nav

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

@Serializable data object Login : NavKey
@Serializable data object SignUp : NavKey
@Serializable data object Rooms : NavKey
@Serializable data class Room(val id: String, val msgId: String? = null) : NavKey
@Serializable data class RoomAccess(val id: String) : NavKey
@Serializable data class Viewer(val roomId: String, val msgId: String, val file: String) : NavKey
@Serializable data object Profile : NavKey
/** "Mentions & replies" (DESIGN.md §41). */
@Serializable data object Inbox : NavKey
/** Your accounts: switch, or add one (ANDROID.md §17.2). */
@Serializable data object AccountList : NavKey
/** A room's images and videos (DESIGN.md §30). */
@Serializable data class Media(val roomId: String) : NavKey
/** A media collection's page (DESIGN.md §31.3), and the viewer over its items. */
@Serializable data class CollectionPage(val id: String) : NavKey
@Serializable data class CollectionViewer(val collection: String, val item: String) : NavKey
/** Shared files or text waiting for a room to go to (§9.3). */
@Serializable data object SharePicker : NavKey

/** Choose a server: for the first account, another one, or instead of this one (ANDROID.md §17.2). */
@Serializable data object ChooseServer : NavKey

/** A room (or a collection) to open in an account (a link, a notification: §17.3). */
data class Linked(val account: String, val room: NavKey)

/**
 * The route of a link's path on its server (`/r/:id`, `/r/:id/m/:msgId` or a collection's `/c/:id`: pathOnServer), or
 * null.
 */
fun routeOf(seg: List<String>): NavKey? {
    if (seg.size >= 2 && seg[0] == "r" && seg[1].matches(ID)) {
        val msg = if (seg.size >= 4 && seg[2] == "m" && seg[3].matches(ID)) seg[3] else null
        return Room(seg[1], msg)
    }
    if (seg.size >= 2 && seg[0] == "c" && seg[1].matches(ID)) return CollectionPage(seg[1])
    return null
}

private val ID = Regex("[a-z0-9]{15}")
