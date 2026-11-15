package chirkle.android

import chirkle.android.data.lib.pathOnServer
import chirkle.android.nav.Room
import chirkle.android.nav.routeOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Links to rooms and messages (DESIGN.md §7.1, ANDROID.md §9.4, §17.3): the web's paths, on the account's server only.
class RoutesTest {
    private fun route(s: String, server: String = "https://chat.example.org") = pathOnServer(server, s)?.let(::routeOf)

    @Test fun `a room and a message in it`() {
        assertEquals(Room("abcdefghij12345"), route("https://chat.example.org/r/abcdefghij12345"))
        assertEquals(Room("abcdefghij12345", "zyxwvutsrq54321"), route("https://chat.example.org/r/abcdefghij12345/m/zyxwvutsrq54321"))
        assertEquals(Room("abcdefghij12345"), route("http://chat.example.org/r/abcdefghij12345"))
    }

    @Test fun `a collection`() {
        assertEquals(chirkle.android.nav.CollectionPage("abcdefghij12345"), route("https://chat.example.org/c/abcdefghij12345"))
        assertEquals(chirkle.android.nav.CollectionPage("abcdefghij12345"), route("https://example.org/chat/c/abcdefghij12345", "https://example.org/chat"))
        assertNull(route("https://chat.example.org/c/short"))
    }

    @Test fun `an invite link (§44)`() {
        val token = "Qm3xT8kLp2Vw9ZrB4nHs7YdC"
        assertEquals(chirkle.android.nav.InviteLink(token), route("https://chat.example.org/invite/$token"))
        assertEquals(chirkle.android.nav.InviteLink(token), route("https://example.org/chat/invite/$token", "https://example.org/chat"))
        assertNull(route("https://chat.example.org/invite/short"))
        assertNull(route("https://chat.example.org/invite/$token/more"))
        assertNull(route("https://chat.example.org/invite/${token.dropLast(1)}!"))
    }

    @Test fun `on a server under a path, or on a port`() {
        assertEquals(Room("abcdefghij12345"), route("https://example.org/chat/r/abcdefghij12345", "https://example.org/chat"))
        assertNull(route("https://example.org/r/abcdefghij12345", "https://example.org/chat"))
        assertEquals(Room("abcdefghij12345"), route("http://10.0.2.2:8090/r/abcdefghij12345", "http://10.0.2.2:8090"))
        assertNull(route("http://10.0.2.2:8091/r/abcdefghij12345", "http://10.0.2.2:8090"))
    }

    @Test fun `nothing else`() {
        assertNull(route("https://evil.example.com/r/abcdefghij12345"))
        assertNull(route("https://chat.example.org.evil.com/r/abcdefghij12345"))
        assertNull(route("https://chat.example.org/r/short"))
        assertNull(route("https://chat.example.org/login"))
        assertNull(route("https://chat.example.org/r/ABCDEFGHIJ12345"))
        assertEquals(Room("abcdefghij12345"), route("https://chat.example.org/r/abcdefghij12345/m/bad"))
    }
}
