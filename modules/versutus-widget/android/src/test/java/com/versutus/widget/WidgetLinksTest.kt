package com.versutus.widget

import org.junit.Assert.assertEquals
import org.junit.Test

class WidgetLinksTest {
  @Test fun `a plain bot id is carried as-is`() {
    assertEquals("versutus://chat?bot=alpha", WidgetLinks.botChatUri("alpha"))
  }

  @Test fun `a bot id that needs encoding is percent-encoded, never raw`() {
    assertEquals("versutus://chat?bot=alpha%2Fbeta%20one", WidgetLinks.botChatUri("alpha/beta one"))
  }

  @Test fun `the activity link is the one the app's own router now answers`() {
    assertEquals("versutus://activity", WidgetLinks.ACTIVITY_URI)
  }
}
