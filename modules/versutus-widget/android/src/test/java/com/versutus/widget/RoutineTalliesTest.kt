package com.versutus.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RoutineTalliesTest {
  @Test fun `the words are failing first, then late, as the operator reads them`() {
    assertEquals("2 failing · 1 late", routineTalliesCopy(2, 1))
    assertEquals("1 failing", routineTalliesCopy(1, 0))
    assertEquals("3 late", routineTalliesCopy(0, 3))
  }

  @Test fun `a silent tally is no row at all, never an empty line`() {
    assertFalse(WidgetPayload(
      status = "Connected",
      connected = true,
      work = "w",
      result = null,
      approvalsPending = 0,
      writtenAt = 5L,
    ).tallies())
    assertTrue(WidgetPayload(
      status = "Connected",
      connected = true,
      work = "w",
      result = null,
      approvalsPending = 0,
      writtenAt = 5L,
      routinesLate = 1,
    ).tallies())
    assertTrue(WidgetPayload(
      status = "Connected",
      connected = true,
      work = "w",
      result = null,
      approvalsPending = 0,
      writtenAt = 5L,
      routinesFailing = 1,
    ).tallies())
  }
}
