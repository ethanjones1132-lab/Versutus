package com.versutus.widget

import org.junit.Assert.assertEquals
import org.junit.Test

class WidgetLayoutTest {
  @Test fun `a 2x2 square is the small layout`() {
    assertEquals(WidgetVariant.SMALL, WidgetLayout.variantFor(110f, 110f))
  }

  @Test fun `a wide short cell is the medium layout`() {
    assertEquals(WidgetVariant.MEDIUM, WidgetLayout.variantFor(250f, 110f))
  }

  @Test fun `a wide tall cell is the large layout`() {
    assertEquals(WidgetVariant.LARGE, WidgetLayout.variantFor(250f, 250f))
  }
}
