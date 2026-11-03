// Room helpers that depend on who is looking (DESIGN.md §16.5, §23): web/src/lib/rooms.ts and the selectors of store.ts.
package chirkle.android.data.lib

import chirkle.android.data.model.Posting
import chirkle.android.data.model.Room
import chirkle.android.data.model.User
import chirkle.android.data.model.Visibility
import java.text.Collator

/** Who can see the room (§23.1); rooms from before visibility existed are public. */
val Room.visibilityOrDefault: Visibility get() = visibility ?: Visibility.Public

val Room.postingOrDefault: Posting get() = posting ?: Posting.Everyone

/** Can [me] post in a room they see (§23.6)? Guests never can; the creator always can. */
fun Room.canPost(me: String?): Boolean {
    if (me.isNullOrEmpty()) return false
    return postingOrDefault != Posting.Selected || createdBy == me || me in writers
}

/**
 * May [me] change the room's access and archive it? Its creator, or a moderator (DESIGN.md §36); never a DM. A copy of
 * another instance's room is changed there (§33.5).
 */
fun Room.canManage(me: User?): Boolean {
    if (me == null || isDm) return false
    return createdBy == me.id || (me.moderator && shared?.home.isNullOrEmpty())
}

/** How each visibility is called and explained (§23.1). */
val Visibility.label: String
    get() = when (this) {
        Visibility.Private -> "Private"
        Visibility.Public -> "Public"
        Visibility.Open -> "Open Air"
    }

val Visibility.hint: String
    get() = when (this) {
        Visibility.Private -> "Only the people you add can read and post."
        Visibility.Public -> "Everyone with an account can read and post."
        Visibility.Open -> "Anyone can read it, even without an account. Everyone with an account can post."
    }

/**
 * Where else a shared room is held (§33.9, web: sharedNote): "Shared with b.example", and "· a.example can't be
 * reached right now" when its home is down (§33.7). "" for a room that isn't shared.
 */
fun Room.sharedNote(): String {
    val s = shared ?: return ""
    if (s.with.isEmpty()) return ""
    val down = if (s.down && s.home.isNotEmpty()) " · ${s.home} can't be reached right now" else ""
    return "Shared with ${s.with.joinToString(", ")}$down"
}

private val ADDRESS = Regex("""^[^@\s][^@]*@([a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d+)?)$""", RegexOption.IGNORE_CASE)

/** Is this an address on another instance, "ann@b.example" (§33.5)? Its host has a dot or a port. Web: isAddress. */
fun isAddress(q: String): Boolean {
    val m = ADDRESS.find(q.trim()) ?: return false
    return m.groupValues[1].any { it == '.' || it == ':' }
}

/** The other member of a DM, if known. */
fun Room.otherMember(me: String?): User? {
    if (!isDm) return null
    val otherId = members.find { it != me } ?: return null
    return expand?.members?.find { it.id == otherId } ?: User(otherId, "Unknown")
}

/**
 * Why a DM takes no new messages: one of the two takes no direct messages (§16.7), as a linked instance's people do once
 * it is unpaired (§33.7). "" while it takes them. Web: dmClosed.
 */
fun Room.dmClosed(me: User?): String {
    if (me == null || !isDm) return ""
    if (me.noDms) return "You've turned off direct messages."
    val other = otherMember(me.id)
    return if (other?.noDms == true) "${other.name} doesn't take direct messages." else ""
}

/** What to call a room: "#name", or the other member's name for a DM. */
fun Room.title(me: String?): String = if (isDm) otherMember(me)?.name ?: "Unknown" else "#$name"

data class RoomSections(val rooms: List<Room>, val dms: List<Room>, val hidden: List<Room>, val archived: List<Room>)

private val collator: Collator = Collator.getInstance().apply { strength = Collator.PRIMARY }
private val byName = Comparator<Room> { a, b -> collator.compare(a.name, b.name) }

/** Most recent activity first: the latest message, or creation for a DM without one yet. */
private val byActivity = Comparator<Room> { a, b ->
    val at = a.lastMessageAt.ifEmpty { a.created }
    val bt = b.lastMessageAt.ifEmpty { b.created }
    when {
        at < bt -> 1
        at > bt -> -1
        else -> a.id.compareTo(b.id)
    }
}

/**
 * Room list sections (§7.1, §16.5). Archived wins over hidden. Open DMs by activity; closed (hidden) DMs left out. A
 * DM nobody has written in yet is listed only for the member who opened it, and while it is open (QA BUG-29, BUG-37).
 * Rooms and DMs with unread messages are listed first.
 */
fun roomSections(rooms: Collection<Room>, hidden: Set<String>, me: String?, activeRoomId: String?, unread: Map<String, Int> = emptyMap()): RoomSections {
    val open = mutableListOf<Room>()
    val dms = mutableListOf<Room>()
    val hid = mutableListOf<Room>()
    val archived = mutableListOf<Room>()
    for (r in rooms) {
        when {
            r.isDm -> {
                val started = r.lastMessageAt.isNotEmpty() || r.createdBy == me || r.id == activeRoomId
                if (started && r.id !in hidden) dms += r
            }
            r.archived -> archived += r
            r.id in hidden -> hid += r
            else -> open += r
        }
    }
    // Rooms and DMs with unread messages first, each group in its usual order.
    val unreadFirst = compareBy<Room> { unreadBadge(it, unread, hidden) == 0 }
    return RoomSections(open.sortedWith(unreadFirst.then(byName)), dms.sortedWith(unreadFirst.then(byActivity)), hid.sortedWith(byName), archived.sortedWith(byName))
}

/**
 * The badge for a room (§18.4): none for hidden or archived rooms (§13). The room you are in keeps its badge (and its
 * place among the unread) until you have scrolled down to its newest messages (2026-11-02).
 */
fun unreadBadge(room: Room, unread: Map<String, Int>, hidden: Set<String>): Int {
    if (room.archived || room.id in hidden) return 0
    return unread[room.id] ?: 0
}
