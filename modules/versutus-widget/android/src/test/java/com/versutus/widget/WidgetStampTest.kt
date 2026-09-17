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

  @Test fun `a future stamp is unreadable even on the same calendar day`() {
    val now = at(2026, 9, 12, 8, 0)
    for (written in listOf(now + 1, at(2026, 9, 13, 8, 0), Long.MAX_VALUE)) {
      assertEquals("Written at an unreadable time", WidgetStamp.line(written, now, zone, Locale.UK))
      assertEquals(false, WidgetStamp.isStale(written, now))
    }
  }

  @Test fun `a clock rolled before the epoch cannot make a future stamp stale by overflow`() {
    val written = at(2026, 9, 12, 8, 0)
    assertEquals("Written at an unreadable time", WidgetStamp.line(written, Long.MIN_VALUE, zone, Locale.UK))
    assertEquals(false, WidgetStamp.isStale(written, Long.MIN_VALUE))
  }

  @Test fun `a stamp becomes readable exactly when the clock catches up`() {
    val written = at(2026, 9, 12, 8, 0)
    assertEquals("Written Today 08:00", WidgetStamp.line(written, written, zone, Locale.UK))
    assertEquals(false, WidgetStamp.isStale(written, written))
    assertEquals("Written Today 08:00", WidgetStamp.line(written, written + 1, zone, Locale.UK))
    assertEquals(false, WidgetStamp.isStale(written, written + 1))
  }

  @Test fun `a snapshot past the stated age is stale`() {
    val twelveHours = 12L * 60 * 60 * 1000
    val written = at(2026, 9, 12, 8, 0)
    // One minute inside the stated age is still fresh; one hour past it is stale.
    assertEquals(false, WidgetStamp.isStale(written, written + twelveHours - 60_000))
    assertEquals(true, WidgetStamp.isStale(written, written + twelveHours + 60 * 60 * 1000))
  }

  @Test fun `the compact stale indicator starts exactly at twelve hours`() {
    val written = at(2026, 9, 12, 8, 0)
    val threshold = written + 12L * 60 * 60 * 1000
    assertEquals(false, WidgetStamp.isStale(written, threshold - 1))
    assertEquals(true, WidgetStamp.isStale(written, threshold))
    assertEquals(true, WidgetStamp.isStale(written, threshold + 1))
  }

  @Test fun `an unreadable stamp is not stale`() {
    assertEquals(false, WidgetStamp.isStale(Long.MIN_VALUE, 9_000_000_000L))
  }
}
