package com.versutus.widget

import org.junit.Assert.assertEquals
import org.junit.Test

class WidgetDescriptionTest {
  private val stamp = "Written Today 08:00"
  private val payload = WidgetPayload(
    status = "Connected", connected = true, work = "1 approval waiting",
    result = "Routine finished", approvalsPending = 1, writtenAt = 1L,
    runs = listOf(WidgetRun("Research", "running")),
    bots = listOf(WidgetBot("anvil", "Anvil"), WidgetBot("rook", "Rook")),
    routinesFailing = 2, routinesLate = 3,
    configBots = listOf(WidgetBot("anvil", "Anvil"), WidgetBot("rook", "Rook"), WidgetBot("keel", "Keel")),
  )

  private fun describe(
    variant: WidgetVariant, value: WidgetPayload = payload, pinned: String? = null, stale: Boolean = false,
  ) = widgetDescription(WidgetPayload.Parsed.Ok(value), variant, pinned, stamp, stale)

  @Test fun `large cards describe every visible row in display order`() {
    assertEquals(
      "Versutus: Connected. 1 approval waiting. Research — running. 2 failing · 3 late. Anvil. Rook. Decide in Versutus. Routine finished. $stamp",
      describe(WidgetVariant.LARGE),
    )
  }

  @Test fun `medium omits runs and small also omits the result and approval action`() {
    assertEquals(
      "Versutus: Connected. 1 approval waiting. 2 failing · 3 late. Anvil. Rook. Decide in Versutus. Routine finished. $stamp",
      describe(WidgetVariant.MEDIUM),
    )
    assertEquals(
      "Versutus: Connected. 1 approval waiting. 2 failing · 3 late. Anvil. Rook. $stamp",
      describe(WidgetVariant.SMALL),
    )
  }

  @Test fun `tiny cards describe only the status or stale label and the connection dot`() {
    assertEquals("Versutus: Connected", describe(WidgetVariant.TINY))
    assertEquals("Versutus: Stale. Connected", describe(WidgetVariant.TINY, stale = true))
    assertEquals("Versutus: Stale. Disconnected", describe(WidgetVariant.TINY, payload.copy(connected = false), stale = true))
  }

  @Test fun `stale warning precedes the live sounding status on larger cards`() {
    assertEquals(
      "Versutus: $stamp — not updated since. Connected. 1 approval waiting. 2 failing · 3 late. Anvil. Rook. $stamp",
      describe(WidgetVariant.SMALL, stale = true),
    )
  }

  @Test fun `a pin names only its Bot including one outside the card rows`() {
    assertEquals(
      "Versutus: Connected. 1 approval waiting. 2 failing · 3 late. Keel. $stamp",
      describe(WidgetVariant.SMALL, pinned = "keel"),
    )
  }

  @Test fun `a missing pin describes recovery rather than a made up Bot`() {
    assertEquals(
      "Versutus: Connected. 1 approval waiting. 2 failing · 3 late. Bot unavailable. Open Versutus. $stamp",
      describe(WidgetVariant.SMALL, pinned = "gone"),
    )
  }

  @Test fun `redaction hides Bot names runs results and missing pin warnings`() {
    for (pin in listOf(null, "keel", "gone")) {
      assertEquals(
        "Versutus: Connected. 1 approval waiting. 2 failing · 3 late. Decide in Versutus. $stamp",
        describe(WidgetVariant.LARGE, payload.copy(redact = true), pinned = pin),
      )
    }
  }

  @Test fun `empty optional rows and zero tallies do not invent announcements`() {
    val quiet = payload.copy(runs = emptyList(), bots = emptyList(), result = null, approvalsPending = 0, routinesFailing = 0, routinesLate = 0)
    assertEquals("Versutus: Connected. 1 approval waiting. $stamp", describe(WidgetVariant.LARGE, quiet))
    assertEquals("Versutus: Connected. 1 approval waiting. 2 late. $stamp", describe(WidgetVariant.LARGE, quiet.copy(routinesLate = 2)))
    assertEquals("Versutus: Connected. 1 approval waiting. 1 failing. $stamp", describe(WidgetVariant.LARGE, quiet.copy(routinesFailing = 1)))
  }

  @Test fun `invalid and unsupported snapshots retain their recovery instructions in every size`() {
    for (variant in WidgetVariant.entries) {
      assertEquals("Versutus: update the app to show status", widgetDescription(WidgetPayload.Parsed.NeedsUpdate, variant, null, "", false))
      assertEquals("Versutus: open the app to connect", widgetDescription(WidgetPayload.Parsed.Invalid, variant, null, "", false))
    }
  }
}
