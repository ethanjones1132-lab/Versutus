package com.versutus.handsfreevoice

import android.media.AudioDeviceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HandsfreeAudioRouteTest {
  private val speaker = HandsfreeRouteDevice(1, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
  private val earpiece = HandsfreeRouteDevice(2, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)
  private val wired = HandsfreeRouteDevice(3, AudioDeviceInfo.TYPE_USB_HEADSET)
  private val bluetooth = HandsfreeRouteDevice(4, AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
  private val ble = HandsfreeRouteDevice(5, AudioDeviceInfo.TYPE_BLE_HEADSET)
  private val a2dp = HandsfreeRouteDevice(6, AudioDeviceInfo.TYPE_BLUETOOTH_A2DP)

  @Test fun pluggingAndUnpluggingAHeadsetOverridesAndRestoresSpeaker() {
    val builtIn = listOf(speaker, earpiece)
    for (headset in listOf(wired, bluetooth, ble)) {
      assertEquals(speaker, chooseHandsfreeAudioRoute(builtIn))
      assertEquals(headset, chooseHandsfreeAudioRoute(builtIn + headset, currentId = speaker.id))
      assertEquals(speaker, chooseHandsfreeAudioRoute(builtIn, currentId = headset.id))
    }
  }

  @Test fun unpluggingWiredFallsBackToBluetoothBeforeSpeaker() {
    val devices = listOf(speaker, bluetooth, wired)
    assertEquals(wired, chooseHandsfreeAudioRoute(devices, currentId = bluetooth.id))
    assertEquals(bluetooth, chooseHandsfreeAudioRoute(devices - wired, currentId = wired.id))
    assertEquals(ble, chooseHandsfreeAudioRoute(listOf(speaker, bluetooth, ble), currentId = ble.id))
  }

  @Test fun mediaOnlyBluetoothIsNotACommunicationRoute() {
    assertEquals(speaker, chooseHandsfreeAudioRoute(listOf(a2dp, speaker), currentId = a2dp.id))
    assertEquals(earpiece, chooseHandsfreeAudioRoute(listOf(a2dp, earpiece)))
    assertNull(chooseHandsfreeAudioRoute(listOf(a2dp)))
  }
}
