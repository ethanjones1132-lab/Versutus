package com.versutus.handsfreevoice

import android.Manifest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsfreeCallPermissionsTest {
  @Test
  fun androidThirteenAsksForNotificationsBesideTheMicrophone() {
    // The first call after install is the one moment the OS will show the
    // notification prompt; it is offered here so the call's foreground service
    // can be visible without a separate ask later.
    val asked = HandsfreeCallPermissions.asked(33)
    assertEquals(2, asked.size)
    assertTrue(asked.contains(Manifest.permission.RECORD_AUDIO))
    assertTrue(asked.contains(Manifest.permission.POST_NOTIFICATIONS))
  }

  @Test
  fun olderAndroidAsksForTheMicrophoneOnly() {
    assertEquals(
      listOf(Manifest.permission.RECORD_AUDIO),
      HandsfreeCallPermissions.asked(32).toList(),
    )
  }

  @Test
  fun onlyTheMicrophoneDecidesThePreflightAnswer() {
    // A refused notification is not a refused call.
    assertEquals("granted", HandsfreeCallPermissions.outcome(true))
    assertEquals("denied", HandsfreeCallPermissions.outcome(false))
  }
}
