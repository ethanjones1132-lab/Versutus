package com.versutus.handsfreevoice

import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsfreeLaunchKeyTest {
  private val key = SecretKeySpec("versutus-test-key".toByteArray(), "HmacSHA256")
  private val otherKey = SecretKeySpec("another-key".toByteArray(), "HmacSHA256")
  private val now = 1_700_000_000_000L

  @Test
  fun thePayloadIsTheDocumentedShape() {
    assertEquals("call|scout|local|1700000000000", HandsfreeLaunchKey.payload("scout", "local", now))
    assertEquals("call||auto|1700000000000", HandsfreeLaunchKey.payload(null, "auto", now))
  }

  @Test
  fun aSignedPayloadVerifiesWithTheSameKey() {
    val payload = HandsfreeLaunchKey.payload("scout", "local", now)
    val sig = HandsfreeLaunchKey.sign(key, payload)
    assertTrue(HandsfreeLaunchKey.verify(key, payload, sig, now, now))
  }

  @Test
  fun aTamperedPayloadOrSignatureFails() {
    val payload = HandsfreeLaunchKey.payload("scout", "local", now)
    val sig = HandsfreeLaunchKey.sign(key, payload)

    // Another Bot, another key, a flipped signature and garbage all fail.
    assertFalse(
      HandsfreeLaunchKey.verify(key, HandsfreeLaunchKey.payload("night", "local", now), sig, now, now),
    )
    assertFalse(HandsfreeLaunchKey.verify(otherKey, payload, sig, now, now))
    assertFalse(HandsfreeLaunchKey.verify(key, payload, "${sig}x", now, now))
    assertFalse(HandsfreeLaunchKey.verify(key, payload, "not-base64!!!", now, now))
  }

  @Test
  fun aLaunchOlderThanThirtyDaysFails() {
    val payload = HandsfreeLaunchKey.payload("scout", "local", now)
    val sig = HandsfreeLaunchKey.sign(key, payload)
    assertFalse(
      HandsfreeLaunchKey.verify(key, payload, sig, now, now + HandsfreeLaunchKey.MAX_AGE_MS + 1),
    )
    assertTrue(HandsfreeLaunchKey.verify(key, payload, sig, now, now + HandsfreeLaunchKey.MAX_AGE_MS))
  }

  @Test
  fun aSignedUrlVerifiesAndEveryWeakerLinkDoesNot() {
    val url = HandsfreeLaunchKey.signedUrl(key, "scout", "local", now)
    assertTrue(HandsfreeLaunchKey.verifyFromKey(key, url, now))

    // No signature at all.
    assertFalse(
      HandsfreeLaunchKey.verifyFromKey(key, "versutus://call?bot=scout&engine=local&autoStart=1", now),
    )
    // A different Bot with the same signature.
    assertFalse(HandsfreeLaunchKey.verifyFromKey(key, url.replace("scout", "night"), now))
    // The right link signed by another key.
    assertFalse(HandsfreeLaunchKey.verifyFromKey(otherKey, url, now))
    // Older than the window.
    assertFalse(HandsfreeLaunchKey.verifyFromKey(key, url, now + HandsfreeLaunchKey.MAX_AGE_MS + 1))
  }
}
