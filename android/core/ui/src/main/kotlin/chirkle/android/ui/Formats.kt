// Times as the web shows them (DESIGN.md §7.5, §7.6.1: web/src/lib/time.ts), with formatters made once per locale.
package chirkle.android.ui

import android.content.res.Resources
import android.text.format.DateFormat
import chirkle.android.data.lib.parsePb
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

object Formats {
    private val cache = ConcurrentHashMap<String, DateTimeFormatter>()

    private fun fmt(skeleton: String, locale: Locale = Locale.getDefault()): DateTimeFormatter =
        cache.getOrPut("${locale.toLanguageTag()}|$skeleton") { DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, skeleton), locale) }

    private fun zoned(ms: Long): ZonedDateTime = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault())

    /** A message's time: time only for today, date and time otherwise (the year only when it differs). */
    fun time(created: String, now: Long = System.currentTimeMillis()): String {
        val ms = parsePb(created)
        if (ms == Long.MIN_VALUE) return ""
        val t = zoned(ms)
        val n = zoned(now)
        return when {
            t.toLocalDate() == n.toLocalDate() -> fmt("jmm").format(t)
            t.year == n.year -> fmt("MMMdjmm").format(t)
            else -> fmt("yMMMdjmm").format(t)
        }
    }

    /** Just the time of day (the row's small time stamp). */
    fun clock(created: String): String {
        val ms = parsePb(created)
        return if (ms == Long.MIN_VALUE) "" else fmt("jmm").format(zoned(ms))
    }

    /** A day divider: "Today", "Yesterday", or a weekday and date. */
    fun day(created: String, res: Resources, now: Long = System.currentTimeMillis()): String {
        val ms = parsePb(created)
        if (ms == Long.MIN_VALUE) return ""
        val d = zoned(ms).toLocalDate()
        val today = zoned(now).toLocalDate()
        return when (d) {
            today -> res.getString(R.string.ui_today)
            today.minusDays(1) -> res.getString(R.string.ui_yesterday)
            else -> (if (d.year == today.year) fmt("EEEEMMMMd") else fmt("EEEEyMMMMd")).format(d)
        }
    }

    /** The full time, e.g. for "(edited)". */
    fun full(created: String): String {
        val ms = parsePb(created)
        return if (ms == Long.MIN_VALUE) "" else fmt("yMMMdjmmss").format(zoned(ms))
    }

    /** The local day a message was sent on, for day dividers. */
    fun localDay(created: String): LocalDate? {
        val ms = parsePb(created)
        return if (ms == Long.MIN_VALUE) null else zoned(ms).toLocalDate()
    }
}
