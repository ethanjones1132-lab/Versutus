package com.versutus.handsfreevoice

import android.Manifest
import android.os.Build

/**
 * What the pre-start microphone prompt asks for. The prompt runs before JS asks
 * the Gate for a session and before any start budget is armed, so its dialog
 * cannot sit inside a timed start — the failure on a first call after install,
 * where a person reading the dialog spent the start's own budget.
 *
 * The microphone alone decides whether the call may start. The notification
 * permission is offered beside it on Android 13+, where the call's foreground
 * notification is otherwise never requested, but refusing that one must not
 * refuse the call.
 */
internal object HandsfreeCallPermissions {
  /** The permissions asked together in the pre-start prompt, for this SDK. */
  fun asked(sdkInt: Int): Array<String> {
    val microphone = Manifest.permission.RECORD_AUDIO
    return if (sdkInt >= Build.VERSION_CODES.TIRAMISU) {
      arrayOf(microphone, Manifest.permission.POST_NOTIFICATIONS)
    } else {
      arrayOf(microphone)
    }
  }

  /** The preflight answer: only the microphone is required. */
  fun outcome(microphoneGranted: Boolean): String =
    if (microphoneGranted) "granted" else "denied"
}
