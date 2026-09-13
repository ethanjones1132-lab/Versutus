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

  @Test fun `a newer version asks for an app update instead of guessing`() {
    assertEquals(WidgetPayload.Parsed.NeedsUpdate, WidgetPayload.parse("""{"v":3,"anything":true}"""))
  }

  @Test fun `junk, missing fields and a non-finite stamp are refused`() {
    assertEquals(WidgetPayload.Parsed.Invalid, WidgetPayload.parse("not json"))
    assertEquals(WidgetPayload.Parsed.Invalid, WidgetPayload.parse("""{"v":1,"status":"Connected"}"""))
    assertEquals(WidgetPayload.Parsed.Invalid, WidgetPayload.parse("""{"v":1,"status":"C","connected":true,"work":"w","approvalsPending":-1,"writtenAt":5}"""))
  }
}
