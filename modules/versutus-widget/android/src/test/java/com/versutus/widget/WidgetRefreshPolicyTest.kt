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
}
