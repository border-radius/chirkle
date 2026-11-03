// What the room controller (RoomController.kt) writes: sends (through the outbox), edits, deletes, deleting several
// (§21) and reactions (§20): a port of web/src/views/room/writes.ts. Each shows at once and is then made good, or undone,
// by the server's answer. Requests run in [writes], so they reach the server even if the screen goes meanwhile.
package chirkle.android.data.repo

import chirkle.android.data.api.ChirkleApi
import chirkle.android.data.lib.MessageWindow
import chirkle.android.data.lib.merge
import chirkle.android.data.lib.newId
import chirkle.android.data.lib.parsePb
import chirkle.android.data.lib.quote
import chirkle.android.data.lib.setReaction
import chirkle.android.data.lib.toPb
import chirkle.android.data.model.CollectionItem
import chirkle.android.data.model.LocalFile
import chirkle.android.data.model.Message
import chirkle.android.data.model.MessageExpand
import chirkle.android.data.model.Reaction
import chirkle.android.data.model.SendStatus
import chirkle.android.data.model.User
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

internal class RoomWrites(
    private val api: ChirkleApi,
    private val outbox: Outbox,
    private val roomId: String,
    /** Whom the room was opened for: the outbox sends as them. */
    private val owner: String,
    /** Where requests run: they outlive the screen. */
    private val writes: CoroutineScope,
    private val host: Host,
) {
    /** What the writes use of the controller. */
    interface Host {
        /** The screen's scope (main): the window is only changed there. */
        val scope: CoroutineScope
        var win: MessageWindow
        fun me(): User?
        fun posting(): Boolean
        fun editable(m: Message): Boolean
        fun deletable(m: Message): Boolean
        fun reactable(m: Message): Boolean
        fun find(id: String): Message?
        fun patchLocal(id: String, fn: (Message) -> Message)
        fun publish(scroll: Scroll? = null)
        /** How to scroll for messages changed where they are. */
        fun inPlace(): Scroll
        /** Back to the live edge, for a message sent from history. */
        suspend fun toLatest()
        /** A message sent: no pill. */
        fun clearPill()
    }

    /** My reaction changes on their way, by message and emoji: on or off, and which change said so last (§20.3). */
    private val reacting = HashMap<String, HashMap<String, Pair<Boolean, Int>>>()
    private var reactSeq = 0
    private val queues = HashMap<String, Mutex>()

    /** The reactions on their way, as [RoomState.reacting] shows them. */
    fun reactingNow(): Map<String, Map<String, Boolean>> = reacting.mapValues { (_, m) -> m.mapValues { it.value.first } }

    // ---------------------------------------------------------------- sending

    fun send(text: String, files: List<LocalFile>, replyTo: Message?, items: List<CollectionItem>): Boolean {
        val user = host.me() ?: return false
        if (!host.posting()) return false
        val quoted = replyTo?.quote()
        host.scope.launch {
            if (host.win.hasNewer) host.toLatest()
            val last = (host.win.items + outbox.messages.value.filter { it.room == roomId }).maxByOrNull { it.created }
            val created = toPb(maxOf(System.currentTimeMillis(), if (last != null) parsePb(last.created) + 1 else 0))
            val msg = Message(
                id = newId(),
                room = roomId,
                author = user.id,
                text = text,
                created = created,
                updated = created,
                replyTo = quoted?.id.orEmpty(),
                expand = MessageExpand(author = user, replyTo = quoted),
                status = SendStatus.Pending,
                localFiles = files,
                localItems = items,
            )
            host.clearPill()
            writes.launch { outbox.enqueue(owner, msg) }.join()
            // The outbox reads back from the database a moment later: follow the message once it is shown, not before.
            withTimeoutOrNull(2000) { outbox.messages.first { q -> q.any { it.id == msg.id } } }
            host.publish(Scroll.Bottom)
        }
        return true
    }

    fun retrySend(id: String) {
        writes.launch { outbox.retry(id) }
    }

    fun discard(id: String) {
        writes.launch { outbox.discard(id) }
    }

    // ---------------------------------------------------------------- edit / delete

    /** Writes go one at a time per message, so the server applies them in the order they were made. */
    private suspend fun <T> inTurn(key: String, write: suspend () -> T): T = queues.getOrPut(key) { Mutex() }.withLock { write() }

    /** Show [patch] at once; keep the server's copy, or put [revert] back if the request fails. */
    private fun optimistic(id: String, patch: (Message) -> Message, revert: (Message) -> Message, request: suspend () -> Message): Deferred<Boolean> {
        host.patchLocal(id, patch)
        host.publish(host.inPlace())
        val done = CompletableDeferred<Boolean>()
        writes.launch {
            val saved = runCatching { inTurn(id) { request() } }.getOrNull()
            host.scope.launch {
                if (saved != null) host.win = host.win.merge(listOf(saved)) else host.patchLocal(id, revert)
                host.publish(host.inPlace())
            }
            done.complete(saved != null)
        }
        return done
    }

    fun edit(id: String, text: String): Deferred<Boolean>? {
        val m = host.find(id) ?: return null
        if (!host.editable(m) || text == m.text) return null
        return optimistic(id, { it.copy(text = text, previews = emptyList()) }, { it.copy(text = m.text, editedAt = m.editedAt, previews = m.previews) }) { api.edit(id, text) }
    }

    fun remove(id: String): Deferred<Boolean>? {
        val m = host.find(id) ?: return null
        // Someone else's, or a moderator's own where they can't post (DESIGN.md §36): only the delete route allows it.
        val mine = m.author == host.me()?.id && host.posting()
        return optimistic(id, { it.copy(text = "", deleted = true) }, { it.copy(text = m.text, deleted = false) }) {
            if (mine) api.softDelete(id) else api.deleteMany(listOf(id)).first()
        }
    }

    fun removeMany(ids: List<String>): Deferred<Throwable?>? {
        val ms = ids.mapNotNull { host.find(it) }.filter { host.deletable(it) }
        if (ms.isEmpty()) return null
        for (m in ms) host.patchLocal(m.id) { it.copy(text = "", deleted = true) }
        host.publish(host.inPlace())
        val done = CompletableDeferred<Throwable?>()
        writes.launch {
            val result = runCatching { api.deleteMany(ms.map { it.id }) }
            host.scope.launch {
                result.onSuccess { saved -> host.win = host.win.merge(saved.filter { host.find(it.id) != null }) }
                    .onFailure { for (m in ms) host.patchLocal(m.id) { it.copy(text = m.text, deleted = false) } }
                host.publish(host.inPlace())
            }
            done.complete(result.exceptionOrNull())
        }
        return done
    }

    // ---------------------------------------------------------------- reactions

    fun reactions(m: Message): List<Reaction> {
        var list = m.reactions
        val user = host.me()?.id ?: return list
        reacting[m.id]?.forEach { (emoji, p) -> list = setReaction(list, emoji, user, p.first) }
        return list
    }

    fun react(id: String, emoji: String, on: Boolean): Deferred<Boolean>? {
        val m = host.find(id) ?: return null
        if (!host.reactable(m)) return null
        val seq = ++reactSeq
        val mine = reacting.getOrPut(id) { HashMap() }
        mine[emoji] = on to seq
        val latest = { mine[emoji]?.second == seq }
        host.publish(host.inPlace())
        val done = CompletableDeferred<Boolean>()
        writes.launch {
            val ok = inTurn(id) {
                if (!latest()) return@inTurn true // changed again before it went out: the later change says what to send
                val saved = runCatching { api.react(id, emoji, on) }.getOrNull()
                if (saved != null) host.scope.launch { if (host.find(id) != null) host.win = host.win.merge(listOf(saved)) }
                saved != null
            }
            host.scope.launch {
                if (latest()) {
                    mine.remove(emoji)
                    if (mine.isEmpty() && reacting[id] === mine) reacting.remove(id)
                    host.publish(host.inPlace())
                }
                done.complete(ok || !latest())
            }
        }
        return done
    }
}
