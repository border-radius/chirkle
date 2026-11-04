package chirkle.android.data.lib

import chirkle.android.data.model.Cursor
import org.junit.Assert.assertEquals
import org.junit.Test

/** The records API filters used with servers from before the page route: the ones the app sent before it (docs/API.md). */
class LegacyPagesTest {
    private val c = Cursor("2026-10-01 10:00:05.000Z", "m5")

    @Test fun `each page as the filter it used to be`() {
        assertEquals(FilterQuery("room = {:room}", mapOf("room" to "r"), "-created,-id"), Pages.latest("r").legacy())
        assertEquals(FilterQuery("room = {:room}", mapOf("room" to "r"), "created,id"), Pages.first("r").legacy())
        assertEquals(
            FilterQuery(
                "room = {:room} && (created < {:created} || (created = {:created} && id < {:id})) && ((files:length > 0 && files != \"[]\") || forward_of != \"\")",
                mapOf("room" to "r", "created" to c.created, "id" to c.id),
                "-created,-id",
            ),
            Pages.withFiles(Pages.older("r", c)).legacy(),
        )
        assertEquals(
            FilterQuery("room = {:room} && (created > {:created} || (created = {:created} && id > {:id}))", mapOf("room" to "r", "created" to c.created, "id" to c.id), "created,id"),
            Pages.newer("r", c).legacy(),
        )
        assertEquals(
            FilterQuery(
                "room = {:room} && updated > {:since} && created >= {:from} && created <= {:to}",
                mapOf("room" to "r", "since" to "s", "from" to c.created, "to" to "t"),
                "updated,id",
            ),
            Pages.changedIn("r", "s", c, Cursor("t", "m9")).legacy(),
        )
    }
}
