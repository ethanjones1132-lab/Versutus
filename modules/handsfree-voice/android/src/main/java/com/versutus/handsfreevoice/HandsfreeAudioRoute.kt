package com.versutus.handsfreevoice

import android.media.AudioDeviceInfo

internal data class HandsfreeRouteDevice(val id: Int, val type: Int)

/**
 * Prefer a wired headset, then Bluetooth call audio, then the loudspeaker.
 * Keep the current device among equally good routes. Media-only Bluetooth
 * (A2DP) is not a route for call audio.
 */
internal fun chooseHandsfreeAudioRoute(
  devices: List<HandsfreeRouteDevice>,
  currentId: Int? = null,
): HandsfreeRouteDevice? = devices.mapNotNull { device ->
  val priority = when (device.type) {
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
    AudioDeviceInfo.TYPE_USB_HEADSET -> 0
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET,
    AudioDeviceInfo.TYPE_HEARING_AID -> 1
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> 2
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> 3
    else -> return@mapNotNull null
  }
  device to priority
}.minWithOrNull(compareBy({ it.second }, { it.first.id != currentId }, { it.first.id }))?.first
