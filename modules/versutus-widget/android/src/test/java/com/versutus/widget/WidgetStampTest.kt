package com.versutus.widget

import java.time.LocalDateTime
import java.time.ZoneId
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test

class WidgetStampTest {
  private val zone = ZoneId.of("America/New_York")
  private fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int) =
    LocalDateTime.of(y, mo, d, h, mi).atZone(zone).toInstant().toEpochMilli()

  @Test fun `same day reads Today with the clock time`() {
    assertEquals("Written Today 14:03", WidgetStamp.line(at(2026, 9, 12, 14, 3), at(2026, 9, 12, 21, 0), zone, Locale.UK))
  }

  @Test fun `the previous calendar day reads Yesterday`() {
    assertEquals("Written Yesterday 23:59", WidgetStamp.line(at(2026, 9, 11, 23, 59), at(2026, 9, 12, 0, 5), zone, Locale.UK))
  }

  @Test fun `within the week reads the weekday, older reads the date`() {
    assertEquals("Written Wednesday 09:00", WidgetStamp.line(at(2026, 9, 9, 9, 0), at(2026, 9, 12, 9, 0), zone, Locale.UK))
    assertEquals("Written 1 Sept 09:00", WidgetStamp.line(at(2026, 9, 1, 9, 0), at(2026, 9, 12, 9, 0), zone, Locale.UK))
  }

  @Test fun `an unreadable stamp says so`() {
    assertEquals("Written at an unreadable time", WidgetStamp.line(Long.MIN_VALUE, 0L, zone, Locale.UK))
  }

  @Test fun `a snapshot past the stated age is stale`() {
    val twelveHours = 12L * 60 * 60 * 1000
    val written = at(2026, 9, 12, 8, 0)
    // One minute inside the stated age is still fresh; one hour past it is stale.
    assertEquals(false, WidgetStamp.isStale(written, written + twelveHours - 60_000))
    assertEquals(true, WidgetStamp.isStale(written, written + twelveHours + 60 * 60 * 1000))
  }

  @Test fun `an unreadable stamp is not stale`() {
    assertEquals(false, WidgetStamp.isStale(Long.MIN_VALUE, 9_000_000_000L))
  }
}
