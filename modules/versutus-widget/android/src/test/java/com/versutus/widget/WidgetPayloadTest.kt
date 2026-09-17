package com.versutus.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WidgetPayloadTest {
  @Test fun `a well-formed v1 payload parses`() {
    val parsed = WidgetPayload.parse(
      """{"v":1,"status":"Connected","connected":true,"work":"1 run in flight","result":"Deployed","approvalsPending":0,"writtenAt":1757700000000}""",
    )
    assertEquals(WidgetPayload.Parsed.Ok(WidgetPayload("Connected", true, "1 run in flight", "Deployed", 0, 1757700000000L)), parsed)
  }

  @Test fun `an absent result stays absent, never an empty line`() {
    val parsed = WidgetPayload.parse(
      """{"v":1,"status":"Disconnected","connected":false,"work":"No runs in flight","approvalsPending":0,"writtenAt":1}""",
    ) as WidgetPayload.Parsed.Ok
    assertNull(parsed.payload.result)
  }

  @Test fun `a v2 payload carries its runs`() {
    val parsed = WidgetPayload.parse(
      """{"v":2,"status":"Connected","connected":true,"work":"1 run in flight","approvalsPending":0,"writtenAt":5,"runs":[{"title":"deploy","state":"Running"}]}""",
    ) as WidgetPayload.Parsed.Ok
    assertEquals(listOf(WidgetRun("deploy", "Running")), parsed.payload.runs)
  }

  @Test fun `v1 is still accepted, with no runs`() {
    val parsed = WidgetPayload.parse(
      """{"v":1,"status":"Connected","connected":true,"work":"w","approvalsPending":0,"writtenAt":5}""",
    ) as WidgetPayload.Parsed.Ok
    assertEquals(emptyList<WidgetRun>(), parsed.payload.runs)
  }

  @Test fun `a v2 payload carries its bots`() {
    val parsed = WidgetPayload.parse(
      """{"v":2,"status":"Connected","connected":true,"work":"w","approvalsPending":0,"writtenAt":5,"bots":[{"id":"alpha","label":"Alpha"}]}""",
    ) as WidgetPayload.Parsed.Ok
    assertEquals(listOf(WidgetBot("alpha", "Alpha")), parsed.payload.bots)
  }

  @Test fun `blank bot rows are skipped and the list is capped at three`() {
    val parsed = WidgetPayload.parse(
      """{"v":2,"status":"C","connected":true,"work":"w","approvalsPending":0,"writtenAt":5,"bots":[{"id":"","label":"x"},{"id":"a","label":"A"},{"id":"b","label":"B"},{"id":"c","label":"C"},{"id":"d","label":"D"}]}""",
    ) as WidgetPayload.Parsed.Ok
    assertEquals(listOf(WidgetBot("a", "A"), WidgetBot("b", "B"), WidgetBot("c", "C")), parsed.payload.bots)
  }

  @Test fun `the full configuration Roster keeps Bots beyond the card cap`() {
    val rows = (1..12).joinToString(",") { """{"id":"bot-$it","label":"Bot $it"}""" }
    val parsed = WidgetPayload.parse(
      """{"v":3,"status":"C","connected":true,"work":"w","approvalsPending":0,"writtenAt":5,"bots":[$rows],"configBots":[{"id":"","label":"bad"},$rows]}""",
    ) as WidgetPayload.Parsed.Ok
    assertEquals(3, parsed.payload.bots.size)
    assertEquals((1..12).map { WidgetBot("bot-$it", "Bot $it") }, parsed.payload.configBots)
    assertEquals(
      WidgetConfigState.Selection(listOf(WidgetBot("bot-12", "Bot 12")), false),
      WidgetConfigState.selection("bot-12", parsed.payload.bots, parsed.payload.configBots),
    )
    assertEquals(
      WidgetConfigState.Selection(parsed.payload.bots, false),
      WidgetConfigState.selection(null, parsed.payload.bots, parsed.payload.configBots),
    )
  }

  @Test fun `older payloads fall back to card Bots but an explicit empty Roster does not`() {
    val json = """{"v":3,"status":"C","connected":true,"work":"w","approvalsPending":0,"writtenAt":5,"bots":[{"id":"a","label":"A"}]}"""
    val old = (WidgetPayload.parse(json) as WidgetPayload.Parsed.Ok).payload
    assertEquals(old.bots, old.configBots)
    val empty = (WidgetPayload.parse(json.dropLast(1) + """, "configBots":[]}""") as WidgetPayload.Parsed.Ok).payload
    assertEquals(emptyList<WidgetBot>(), empty.configBots)
    assertEquals(WidgetConfigState.Selection(emptyList(), true), WidgetConfigState.selection("a", empty.bots, empty.configBots))
    val redacted = (WidgetPayload.parse(json.dropLast(1) + """, "redact":true, "configBots":[{"id":"a","label":"A"}]}""") as WidgetPayload.Parsed.Ok).payload
    assertEquals(emptyList<WidgetBot>(), redacted.configBots)
  }

  @Test fun `a v1 payload carries no bots`() {
    val parsed = WidgetPayload.parse(
      """{"v":1,"status":"C","connected":true,"work":"w","approvalsPending":0,"writtenAt":5}""",
    ) as WidgetPayload.Parsed.Ok
    assertEquals(emptyList<WidgetBot>(), parsed.payload.bots)
  }

  @Test fun `a redacted v2 payload parses with nothing private on it`() {
    val parsed = WidgetPayload.parse(
      """{"v":2,"status":"Connected","connected":true,"work":"w","approvalsPending":0,"writtenAt":5,"redact":true}""",
    ) as WidgetPayload.Parsed.Ok
    assertEquals(true, parsed.payload.redact)
    assertNull(parsed.payload.result)
    assertEquals(emptyList<WidgetBot>(), parsed.payload.bots)
  }

  @Test fun `a v3 payload carries its routine tallies`() {
    val parsed = WidgetPayload.parse(
      """{"v":3,"status":"Connected","connected":true,"work":"w","approvalsPending":0,"writtenAt":5,"routinesFailing":2,"routinesLate":1}""",
    ) as WidgetPayload.Parsed.Ok
    assertEquals(2, parsed.payload.routinesFailing)
    assertEquals(1, parsed.payload.routinesLate)
  }

  @Test fun `a v3 payload without tallies carries none, and negative ones clamp to zero`() {
    val plain = WidgetPayload.parse(
      """{"v":3,"status":"Connected","connected":true,"work":"w","approvalsPending":0,"writtenAt":5}""",
    ) as WidgetPayload.Parsed.Ok
    assertEquals(0, plain.payload.routinesFailing)
    assertEquals(0, plain.payload.routinesLate)
    val negative = WidgetPayload.parse(
      """{"v":3,"status":"Connected","connected":true,"work":"w","approvalsPending":0,"writtenAt":5,"routinesFailing":-2,"routinesLate":-1}""",
    ) as WidgetPayload.Parsed.Ok
    assertEquals(0, negative.payload.routinesFailing)
    assertEquals(0, negative.payload.routinesLate)
  }

  @Test fun `a v3 payload missing the required fields is invalid, still an app-side refusal`() {
    assertEquals(WidgetPayload.Parsed.Invalid, WidgetPayload.parse("""{"v":3,"anything":true}"""))
  }

  @Test fun `a version beyond the card's own asks for an app update instead of guessing`() {
    assertEquals(WidgetPayload.Parsed.NeedsUpdate, WidgetPayload.parse("""{"v":4,"anything":true}"""))
  }

  @Test fun `junk, missing fields and a non-finite stamp are refused`() {
    assertEquals(WidgetPayload.Parsed.Invalid, WidgetPayload.parse("not json"))
    assertEquals(WidgetPayload.Parsed.Invalid, WidgetPayload.parse("""{"v":1,"status":"Connected"}"""))
    assertEquals(WidgetPayload.Parsed.Invalid, WidgetPayload.parse("""{"v":1,"status":"C","connected":true,"work":"w","approvalsPending":-1,"writtenAt":5}"""))
  }
}
