package chirkle.android.data.lib

import org.junit.Assert.assertEquals
import org.junit.Test

// The cases of forwardHeader in tests/unit/lib/messages.test.ts.
class ForwardHeaderTest {
    @Test fun splitsOffTheBridgesForwardLine() {
        assertEquals("↪ Forwarded from Bob" to "hello\nthere", forwardHeader("↪ Forwarded from Bob\nhello\nthere"))
        assertEquals("↪ Forwarded from Bob" to "", forwardHeader("↪ Forwarded from Bob"))
    }

    @Test fun leavesOtherTextAlone() {
        assertEquals("" to "hello", forwardHeader("hello"))
        assertEquals("" to "hi\n↪ Forwarded from Bob", forwardHeader("hi\n↪ Forwarded from Bob"))
        assertEquals("" to "↪ Forwarded from \nx", forwardHeader("↪ Forwarded from \nx"))
    }
}
