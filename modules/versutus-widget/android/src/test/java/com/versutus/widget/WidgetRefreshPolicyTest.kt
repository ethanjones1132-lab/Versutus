package com.versutus.widget

import org.junit.Assert.assertEquals
import org.junit.Test

class WidgetRefreshPolicyTest {
  @Test fun `the refresh runs every six hours`() {
    assertEquals(360L, WidgetRefreshPolicy.intervalMinutes())
  }

  @Test fun `the work is enqueued under one name, so a repeat is KEEP`() {
    assertEquals("versutus-widget-refresh", WidgetRefreshPolicy.uniqueName())
  }

  @Test fun `every call answers that same name, so repeats cannot stack a second worker`() {
      // WorkManager matches existing work on the name alone, and enqueue passes
      // ExistingPeriodicWorkPolicy.KEEP, so a second call is a no-op rather than
      // a second redraw. The name is the pure half of that and is pinned here;
      // the policy itself is Android-bound and is read, not called.
      val names = List(4) { WidgetRefreshPolicy.uniqueName() }
      assertEquals(1, names.distinct().size)
    }
}
