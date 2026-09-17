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

  @Test fun `an unpinned widget keeps its quick-launch Bots`() {
    val bots = listOf(WidgetBot("scout", "Scout"), WidgetBot("builder", "Builder"))
    assertEquals(WidgetConfigState.Selection(bots, false), WidgetConfigState.selection(null, bots))
  }

  @Test fun `a present pin keeps the roster name and only that Bot`() {
    val scout = WidgetBot("scout", "Scout")
    val bots = listOf(scout, WidgetBot("builder", "Builder"))
    assertEquals(WidgetConfigState.Selection(listOf(scout), false), WidgetConfigState.selection("scout", bots))
  }

  @Test fun `a missing pin is unavailable with no Bot Chat target`() {
    val bots = listOf(WidgetBot("builder", "Builder"))
    assertEquals(WidgetConfigState.Selection(emptyList(), true), WidgetConfigState.selection("scout", bots))
    assertEquals(WidgetConfigState.Selection(emptyList(), true), WidgetConfigState.selection("scout", emptyList()))
    assertEquals(WidgetConfigState.Selection(emptyList(), false), WidgetConfigState.selection(null, emptyList()))
  }

  @Test fun `a returning Bot recovers without rewriting the pin`() {
    val pin = WidgetConfigState.read(WidgetConfigState.write(" scout "))
    assertEquals(WidgetConfigState.Selection(emptyList(), true), WidgetConfigState.selection(pin, emptyList()))
    val renamed = WidgetBot("scout", "Scout returned")
    assertEquals(WidgetConfigState.Selection(listOf(renamed), false), WidgetConfigState.selection(pin, listOf(renamed)))
  }

  @Test fun `the pin lives under one namespaced key`() {
    assertEquals("configured_bot_id", WidgetConfigState.BOT_KEY)
  }
}
