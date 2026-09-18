package com.versutus.handsfreevoice

import org.junit.Assert.assertEquals
import org.junit.Test

class HeaderValueTest {
  @Test fun `a token with a trailing carriage return is sent without it`() {
    assertEquals("test-gateway-token", cleanHeaderValue("test-gateway-token\r"))
  }

  @Test fun `line breaks, tabs and surrounding spaces are removed`() {
    assertEquals("test-gateway-token", cleanHeaderValue("  test-gateway-token\r\n\t"))
  }

  @Test fun `a clean token is unchanged`() {
    assertEquals("abc-DEF_123.xyz", cleanHeaderValue("abc-DEF_123.xyz"))
  }
}
