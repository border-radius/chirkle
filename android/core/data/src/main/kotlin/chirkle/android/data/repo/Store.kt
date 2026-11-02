// The app's shared state (DESIGN.md §7.4): web/src/store.ts as a StateFlow. Message windows are owned by the room's
// controller, not kept here. Updated on the main thread only, so updates never interleave.
package chirkle.android.data.repo

import chirkle.android.data.model.Room
import chirkle.android.data.model.Site
import chirkle.android.data.model.User
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Where the room list is in its load cycle. Error keeps whatever was loaded before. */
enum class LoadStatus { Idle, Loading, Ready, Error }

data class AppState(
    val user: User? = null,
    val rooms: Map<String, Room> = emptyMap(),
    /** roomId → hidden_rooms row id (needed to unhide). */
    val hidden: Map<String, String> = emptyMap(),
    /** roomId → unread messages (§18); rooms without any are absent. [counted] is false until the counts are first in. */
    val unread: Map<String, Int> = emptyMap(),
    val counted: Boolean = false,
    val roomsStatus: LoadStatus = LoadStatus.Idle,
    val activeRoomId: String? = null,
    /** Your media collections and those you follow (DESIGN.md §31): null until loaded (and for a guest). */
    val collections: chirkle.android.data.model.Collections? = null,
    /** The app isn't visible (§22.4): nobody is reading the open room, so its new messages count too. */
    val away: Boolean = false,
    /** Branding and signup policy (§24): not the session's, so it stays when the session ends. */
    val site: Site = Site.DEFAULT,
) {
    /** Unread messages that would show a badge (§18.4): the launcher badge. */
    val unreadTotal: Int
        get() = rooms.values.sumOf { chirkle.android.data.lib.unreadBadge(it, unread, hidden.keys) }
}

class Store(initial: AppState = AppState()) {
    private val state = MutableStateFlow(initial)
    private val listeners = mutableListOf<(AppState, AppState) -> Unit>()

    /** For the UI: the latest state (collectors may skip states in between). */
    val flow: StateFlow<AppState> = state.asStateFlow()

    fun get(): AppState = state.value

    /** Apply [fn]; listeners hear every change, in order, before update returns (like the web's store). */
    fun update(fn: (AppState) -> AppState) {
        val prev = state.value
        val next = fn(prev)
        if (next == prev) return
        state.value = next
        for (l in listeners.toList()) l(next, prev)
    }

    /** Hear every change as it happens, with the state before it. Returns the unsubscribe. */
    fun listen(fn: (state: AppState, prev: AppState) -> Unit): () -> Unit {
        listeners += fn
        return { listeners -= fn }
    }
}

// ---- updates, as store.ts has them. Maps are replaced, never changed, so observers can compare.

fun AppState.upsertRoom(r: Room) = copy(rooms = rooms + (r.id to r))

fun AppState.removeRoom(id: String) = if (id in rooms) copy(rooms = rooms - id) else this

fun AppState.markHidden(room: String, row: String) = copy(hidden = hidden + (room to row))

/** The room is no longer hidden (a DM reopened, which deleted the row). */
fun AppState.unmarkHiddenRoom(room: String) = if (room in hidden) copy(hidden = hidden - room) else this

/** Forget a hidden_rooms row (a realtime delete only carries the row id). */
fun AppState.unmarkHidden(row: String) = copy(hidden = hidden.filterValues { it != row })

fun AppState.bumpUnread(room: String) = copy(unread = unread + (room to (unread[room] ?: 0) + 1))

fun AppState.clearUnread(room: String) = if (room in unread) copy(unread = unread - room) else this
