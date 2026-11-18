package com.versutus.handsfreevoice

/**
 * Android requires every startForegroundService delivery to promote before
 * returning from onStartCommand, even when its call attempt has expired.
 */
internal object HandsfreeStartAdmission {
  fun admit(
    attemptId: String?,
    promote: () -> Unit,
    owns: (String) -> Boolean,
    reject: () -> Unit,
  ): Boolean {
    promote()
    if (attemptId != null && !owns(attemptId)) {
      reject()
      return false
    }
    return true
  }
}
