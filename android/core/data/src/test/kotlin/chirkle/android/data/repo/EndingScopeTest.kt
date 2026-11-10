package chirkle.android.data.repo

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

// endingScope (ANDROID.md §63): work still running when its account's services stop fails quietly, e.g. a database
// call made as the forgotten account's database closed (`SQLException`, UiAccountsTest).
class EndingScopeTest {
    private val errors = Collections.synchronizedList(mutableListOf<Throwable>())
    private val reported = CountDownLatch(1)
    private val pool = Executors.newSingleThreadExecutor { r ->
        Thread(r, "test-main").apply {
            isDaemon = true
            setUncaughtExceptionHandler { _, e ->
                errors += e
                reported.countDown()
            }
        }
    }
    private val main = pool.asCoroutineDispatcher()

    @After fun tearDown() {
        pool.shutdownNow()
    }

    @Test fun `an error after the scope is cancelled is dropped`() = runBlocking {
        val scope = endingScope(null, main)
        val started = CompletableDeferred<Unit>()
        val failed = CompletableDeferred<Unit>()
        scope.launch {
            withContext(NonCancellable) {
                started.complete(Unit)
                // The database closed under it: an error that isn't a cancellation.
                kotlinx.coroutines.delay(50)
                failed.complete(Unit)
                throw IllegalStateException("connection is closed")
            }
        }
        started.await()
        scope.cancel()
        withTimeout(5000) { failed.await() }
        kotlinx.coroutines.delay(100)
        assertEquals(emptyList<Throwable>(), errors.toList())
    }

    @Test fun `an error while it runs still crashes`() = runBlocking {
        val scope = endingScope(null, main)
        scope.launch { throw IllegalStateException("a bug") }
        reported.await(5, TimeUnit.SECONDS)
        assertEquals(listOf("a bug"), errors.map { it.message })
    }
}
