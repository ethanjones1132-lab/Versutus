package com.versutus.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WidgetConfigStateTest {
  @Test fun `a blank or absent pin is no pin`() {
    assertNull(WidgetConfigState.read(null))
    assertNull(WidgetConfigState.read("   "))
  }

  @Test fun `a pin is trimmed to its id`() {
    assertEquals("scout", WidgetConfigState.read(" scout "))
    assertEquals("scout", WidgetConfigState.write(" scout "))
  }

  @Test fun `the pin lives under one namespaced key`() {
    assertEquals("configured_bot_id", WidgetConfigState.BOT_KEY)
  }
}
