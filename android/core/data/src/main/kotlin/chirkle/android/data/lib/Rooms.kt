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
        Visibility.Private -> Strings.PRIVATE
        Visibility.Public -> Strings.PUBLIC
        Visibility.Open -> Strings.OPEN_AIR
    }

val Visibility.hint: String
    get() = when (this) {
        Visibility.Private -> Strings.ONLY_THE_PEOPLE_YOU_ADD_CAN
        Visibility.Public -> Strings.EVERYONE_WITH_AN_ACCOUNT_CAN_READ
        Visibility.Open -> Strings.ANYONE_CAN_READ_IT
    }

/**
 * Where else a shared room is held (§33.9, web: sharedNote): "Shared with b.example", and "· a.example can't be
 * reached right now" when its home is down (§33.7). "" for a room that isn't shared.
 */
fun Room.sharedNote(): String {
    val s = shared ?: return ""
    if (s.with.isEmpty()) return ""
    val down = if (s.down && s.home.isNotEmpty()) Strings.cantBeReachedRightNow(s.home) else ""
    return Strings.sharedWith(s.with.joinToString(", "), down)
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
    return expand?.members?.find { it.id == otherId } ?: User(otherId, Strings.UNKNOWN)
}

/**
 * Why a DM takes no new messages: one of the two takes no direct messages (§16.7), as a linked instance's people do once
 * it is unpaired (§33.7). "" while it takes them. Web: dmClosed.
 */
fun Room.dmClosed(me: User?): String {
    if (me == null || !isDm) return ""
    if (me.noDms) return Strings.YOUVE_TURNED_OFF_DIRECT_MESSAGES
    val other = otherMember(me.id)
    return if (other?.noDms == true) Strings.doesntTakeDirectMessages(other.name) else ""
}

/** What to call a room: "#name", or the other member's name for a DM. */
fun Room.title(me: String?): String = if (isDm) otherMember(me)?.name ?: Strings.UNKNOWN else "#$name"

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

/**
 * The listed room (not a DM) that [name] would clash with on create, as the server compares names
 * ([listedNameKey]), or null: said as you type in New room (web/src/views/rooms-forms.ts `taken`).
 */
fun takenRoom(rooms: Collection<Room>, name: String): Room? {
    val key = listedNameKey(name, room = true)
    if (key.isEmpty()) return null
    return rooms.firstOrNull { !it.isDm && listedNameKey(it.name, room = true) == key }
}

/** Your collection that [name] would clash with on create, or null (New collection's taken line). */
fun takenCollection(mine: List<chirkle.android.data.model.MediaCollection>, name: String): chirkle.android.data.model.MediaCollection? {
    val key = listedNameKey(name)
    if (key.isEmpty()) return null
    return mine.firstOrNull { listedNameKey(it.name) == key }
}

/**
 * What a room's row shows for unread (web/src/views/rooms.ts `roomRow`, 2026-11-23): numbers only for what is addressed
 * to you, a room's unread mentions of and replies to you, or a DM's unread messages; otherwise a dot.
 */
sealed interface UnreadMark {
    data object None : UnreadMark
    /** [unread]: how many, read out though not shown. */
    data class Dot(val unread: Int) : UnreadMark
    data class Count(val n: Int, val mentions: Boolean, val unread: Int) : UnreadMark
}

fun unreadMark(room: Room, unread: Int, mentions: Int): UnreadMark = when {
    unread <= 0 -> UnreadMark.None
    mentions > 0 -> UnreadMark.Count(mentions, mentions = true, unread = unread)
    room.isDm -> UnreadMark.Count(unread, mentions = false, unread = unread)
    else -> UnreadMark.Dot(unread)
}

/**
 * Whose faces the scroll button shows (web/src/views/room.ts `renderPill`, the room view redesign): the newest three
 * authors (not [me], each once, oldest of them first) of the messages after [seenLast], the newest one there was
 * while nothing new was out of sight (when it is gone from [items], or null, all of [items] count).
 */
fun pillFaces(items: List<chirkle.android.data.model.Message>, seenLast: String?, me: String?): List<User> {
    val since = if (seenLast == null) -1 else items.indexOfFirst { it.id == seenLast }
    val who = ArrayDeque<User>()
    val seen = HashSet<String>()
    for (m in items.subList(since + 1, items.size).asReversed()) {
        val a = m.expand?.author ?: continue
        if (a.id == me || !seen.add(a.id)) continue
        who.addFirst(a)
        if (who.size == 3) break
    }
    return who.toList()
}
