package chirkle.android.data.pb

import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class PbClientTest {
    /**
     * A call cancelled just as its answer came (a screen closed, the services stopped) dropped the answer unread. Its
     * connection stayed taken, and OkHttp later gave it to another request with the old body still in front: that one
     * failed with "Unexpected status line: {…}HTTP/1.1 200 OK", seen as random failures in the data tests.
     */
    @Test fun `an answer whose caller is cancelled as it arrives is closed, and its connection is free again`() = runBlocking {
        MockWebServer().use { server ->
            val body = """{"data":{},"message":"Only superusers can perform this action.","status":403}"""
            server.enqueue(MockResponse.Builder().code(403).addHeader("Content-Type", "application/json").body(body).headersDelay(300, TimeUnit.MILLISECONDS).build())
            server.enqueue(MockResponse.Builder().code(200).addHeader("Content-Type", "application/json").body("""{"ok":true}""").build())
            server.start()
            val sent = CountDownLatch(1)
            val answered = CountDownLatch(1)
            val http = OkHttpClient.Builder().eventListener(object : EventListener() {
                override fun requestHeadersEnd(call: Call, request: Request) = sent.countDown()
                override fun responseHeadersEnd(call: Call, response: Response) = answered.countDown()
            }).build()
            val pb = PbClient(server.url("/").toString(), http, MemoryAuthStore())
            val caller = Executors.newSingleThreadExecutor()
            val free = CountDownLatch(1)
            try {
                val job = launch(caller.asCoroutineDispatcher()) { pb.send("/api/collections/files/records") }
                assertTrue(sent.await(5, TimeUnit.SECONDS))
                // The caller's thread is busy when the answer comes, so the resume waits; meanwhile the caller is cancelled.
                caller.execute { free.await() }
                assertTrue(answered.await(5, TimeUnit.SECONDS))
                Thread.sleep(200) // onResponse has resumed by now
                job.cancel()
                free.countDown()
                job.join()
                assertTrue(job.isCancelled)
                assertEquals("no connection held by an unread answer", http.connectionPool.connectionCount(), http.connectionPool.idleConnectionCount())
                // And the next request on that connection reads its own answer.
                assertEquals("true", pb.send("/next").obj["ok"].toString())
            } finally {
                caller.shutdownNow()
            }
        }
    }
}
