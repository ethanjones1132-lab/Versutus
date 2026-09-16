package com.versutus.handsfreevoice

import android.media.AudioManager
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsfreeFocusPolicyTest {
  @Test fun aTransientLossRightAfterOurOwnListenStartDoesNotEndTheCall() {
    // On 2026-09-16 every call ended the moment it started, reporting "another
    // app or a phone call took the audio". The system speech recognizer takes
    // transient audio focus when WE start it, so the call's own focus listener
    // heard a loss it had caused and hung up. That loss lands within moments of
    // startListening, every time listening (re)starts.
    assertFalse(HandsfreeFocusPolicy.endsCall(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, 0L))
    assertFalse(HandsfreeFocusPolicy.endsCall(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, 400L))
    assertFalse(
      HandsfreeFocusPolicy.endsCall(
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
        HandsfreeFocusPolicy.SELF_INFLICTED_WINDOW_MS,
      ),
    )
  }

  @Test fun aTransientLossWellAfterListeningStartedStillEndsTheCall() {
    // Outside the window nothing of ours explains the loss: a phone call or
    // another app has the audio, and the product contract says a call never
    // resumes itself after one.
    assertTrue(
      HandsfreeFocusPolicy.endsCall(
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
        HandsfreeFocusPolicy.SELF_INFLICTED_WINDOW_MS + 1,
      ),
    )
    assertTrue(HandsfreeFocusPolicy.endsCall(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, 60_000L))
  }

  @Test fun aTransientLossWithNoListenStartOnRecordEndsTheCall() {
    // While speaking or idle there is no recognizer start to blame, so the
    // loss is someone else's.
    assertTrue(HandsfreeFocusPolicy.endsCall(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, null))
  }

  @Test fun aPermanentLossAlwaysEndsTheCall() {
    // Permanent loss is never something a recognizer start produces.
    assertTrue(HandsfreeFocusPolicy.endsCall(AudioManager.AUDIOFOCUS_LOSS, 0L))
    assertTrue(HandsfreeFocusPolicy.endsCall(AudioManager.AUDIOFOCUS_LOSS, null))
  }

  @Test fun duckingAndGainsNeverEndTheCall() {
    // A notification chime or a navigation prompt ducks the call; that is not a
    // reason to end it. Regaining focus is not a loss at all.
    assertFalse(HandsfreeFocusPolicy.endsCall(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK, null))
    assertFalse(HandsfreeFocusPolicy.endsCall(AudioManager.AUDIOFOCUS_GAIN, null))
  }
}
