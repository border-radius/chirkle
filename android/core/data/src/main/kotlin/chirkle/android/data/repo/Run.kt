package chirkle.android.data.repo

import chirkle.android.data.pb.Unsubscribe
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * A scope for work that is thrown away when it ends: an error after [CoroutineScope.cancel] is dropped, not a crash. A
 * request or database call already running when an account is switched away from or forgotten fails as it can (its
 * database closed: `SQLException`), not with a cancellation (ANDROID.md §63). Errors while it runs crash as before.
 */
fun endingScope(parent: Job?, main: CoroutineDispatcher): CoroutineScope {
    val job = SupervisorJob(parent)
    val handler = CoroutineExceptionHandler { _, e ->
        if (job.isCancelled) return@CoroutineExceptionHandler
        val t = Thread.currentThread()
        t.uncaughtExceptionHandler?.uncaughtException(t, e)
    }
    return CoroutineScope(job + main + handler)
}

/**
 * One run of a service (the web's Scope): its coroutines, and what to undo when it ends. Callbacks hold on to their run,
 * so a restart can't revive them.
 */
class Run(parent: Job?, val main: CoroutineDispatcher) {
    val scope = endingScope(parent, main)
    private val undo = mutableListOf<() -> Unit>()

    val active: Boolean get() = scope.isActive

    fun defer(fn: () -> Unit) {
        undo += fn
    }

    /** Run [fn] on the main thread, if this run is still going (realtime listeners call from their own thread). */
    fun post(fn: () -> Unit) {
        scope.launch { if (active) fn() }
    }

    /** Subscribe now; unsubscribed when the run ends. */
    fun sub(subscribe: suspend () -> Unsubscribe) {
        scope.launch {
            val off = subscribe()
            if (active) defer { cleanup(off) } else cleanup(off)
        }
    }

    fun dispose() {
        scope.cancel()
        undo.asReversed().forEach { runCatching(it) }
        undo.clear()
    }

    companion object {
        /** Unsubscribes outlive the run that made them. */
        private val CLEANUP = CoroutineScope(SupervisorJob() + Dispatchers.Default + NonCancellable)

        fun cleanup(off: Unsubscribe) {
            CLEANUP.launch { runCatching { off() } }
        }
    }
}
