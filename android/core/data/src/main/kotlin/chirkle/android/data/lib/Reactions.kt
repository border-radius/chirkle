// Emoji reactions (DESIGN.md §20): web/src/lib/reactions.ts.
package chirkle.android.data.lib

import chirkle.android.data.model.Reaction

/**
 * [list] with [user]'s [emoji] added ([on]) or removed, the way the server does it (pb_hooks/lib/reactions.js): a
 * new emoji goes last, one nobody uses any more goes away. The same list when unchanged.
 */
fun setReaction(list: List<Reaction>, emoji: String, user: String, on: Boolean): List<Reaction> {
    val r = list.find { it.emoji == emoji }
    if (r != null && (user in r.users) == on) return list
    if (!on && r == null) return list
    if (on) return if (r != null) list.map { if (it === r) Reaction(emoji, it.users + user) else it } else list + Reaction(emoji, listOf(user))
    return list.map { if (it === r) Reaction(emoji, it.users - user) else it }.filter { it.users.isNotEmpty() }
}

/** "You", "You and Ada", "Ada, Bob and 3 others": who reacted, with names where they are known. */
fun reactors(users: List<String>, me: String, names: (String) -> String?): String {
    val known = ArrayDeque<String>()
    var others = 0
    for (id in users) {
        val name = if (id == me) Strings.YOU else names(id)
        when {
            name == null -> others++
            id == me -> known.addFirst(name)
            else -> known.addLast(name)
        }
    }
    val shown = known.take(5).toMutableList()
    others += known.size - shown.size
    if (others > 0) {
        shown += if (shown.isNotEmpty()) Strings.others(others) else Strings.people(others)
    }
    if (shown.size == 1) return shown[0]
    return Strings.and(shown.dropLast(1).joinToString(", "), shown.last())
}
