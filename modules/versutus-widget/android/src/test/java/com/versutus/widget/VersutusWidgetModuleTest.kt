package com.versutus.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VersutusWidgetModuleTest {
  private val good =
    """{"v":1,"status":"Connected","connected":true,"work":"No runs in flight","approvalsPending":0,"writtenAt":5}"""

  /** Records what a call did, in order, so "scheduled first" is assertable. */
  private class Calls {
    val events = ArrayList<String>()
    val schedule: () -> Unit = { events.add("schedule") }
    val write: (String) -> Unit = { events.add("write $it") }
  }

  @Test fun `an accepted payload is stored and the redraw is scheduled`() {
    val calls = Calls()
    assertTrue(storePayloadIfDrawable(good, calls.schedule, calls.write))
    assertEquals(listOf("schedule", "write $good"), calls.events)
  }

  @Test fun `a refused payload is never stored but still leaves the redraw scheduled`() {
    val calls = Calls()
    assertFalse(storePayloadIfDrawable("not json", calls.schedule, calls.write))
    assertEquals(listOf("schedule"), calls.events)
  }

  @Test fun `a payload the card cannot draw is refused, not stored, and still schedules`() {
    val calls = Calls()
    assertFalse(storePayloadIfDrawable("""{"v":4,"status":"C"}""", calls.schedule, calls.write))
    assertEquals(listOf("schedule"), calls.events)
  }

  @Test fun `each call schedules once, so a repeat is the same KEEP and adds no second worker`() {
    val calls = Calls()
    storePayloadIfDrawable(good, calls.schedule, calls.write)
    storePayloadIfDrawable("not json", calls.schedule, calls.write)
    assertEquals(listOf("schedule", "write $good", "schedule"), calls.events)
  }
}