package com.versutus.handsfreevoice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import androidx.core.content.ContextCompat
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The thin JS boundary over [HandsfreeCallService]. It owns no audio itself:
 * every method is a request forwarded to the running service, and every
 * platform observation travels back through [HandsfreeEventBridge].
 */
class HandsfreeVoiceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HandsfreeVoice")

    Events(
      "partial",
      "final",
      "noSpeech",
      "speechFinished",
      "interruption",
      "endRequested",
      "fatalError",
      "bargeIn",
      "level",
    )

    OnCreate {
      HandsfreeEventBridge.attach(this@HandsfreeVoiceModule)
    }

    OnDestroy {
      HandsfreeEventBridge.detach()
      HandsfreeCallService.current?.end("app-killed")
    }

    // What this device can do, read from installed services. Constructing a
    // TextToSpeech engine here raced a cold Samsung TTS against a 1.5 s timeout
    // and hid Call; the service creates its engine when it first speaks.
    AsyncFunction("getAvailability") {
      val context = appContext.reactContext
      if (context == null) {
        mapOf("recognition" to false, "synthesis" to false, "maxSpeechInputLength" to 0)
      } else {
        val recognition = SpeechRecognizer.isRecognitionAvailable(context)
        val ttsEngines = context.packageManager.queryIntentServices(
          Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE),
          0,
        )
        val synthesis = ttsEngines.isNotEmpty()
        mapOf(
          "recognition" to recognition,
          "synthesis" to synthesis,
          "maxSpeechInputLength" to if (synthesis) TextToSpeech.getMaxSpeechInputLength() else 0,
        )
      }
    }

    AsyncFunction("startSession") { options: Map<String, Any?>, promise: Promise ->
      val title = (options["title"] as? String)?.trim().orEmpty()
      if (appContext.currentActivity == null) {
        promise.resolve("unavailable")
        return@AsyncFunction
      }
      val context = appContext.reactContext
      if (context == null) {
        promise.resolve("unavailable")
        return@AsyncFunction
      }
      val needed = mutableListOf(Manifest.permission.RECORD_AUDIO)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        needed.add(Manifest.permission.POST_NOTIFICATIONS)
      }
      val permissions = appContext.permissions
      if (permissions == null || permissions.hasGrantedPermissions(*needed.toTypedArray())) {
        startService(context, title, promise)
      } else {
        permissions.askForPermissions({ result ->
          val granted = needed.all { result[it]?.status == PermissionsStatus.GRANTED }
          if (!granted) {
            promise.resolve("permission-denied")
          } else {
            startService(context, title, promise)
          }
        }, *needed.toTypedArray())
      }
    }

    AsyncFunction("startListening") {
      HandsfreeCallService.current?.startListening() ?: false
    }

    AsyncFunction("stopListening") {
      HandsfreeCallService.current?.stopListening()
    }

    AsyncFunction("speak") { options: Map<String, Any?> ->
      val chunks = (options["chunks"] as? List<*>)?.filterIsInstance<String>() ?: emptyList()
      val voiceIdentifier = options["voiceIdentifier"] as? String
      val rate = (options["rate"] as? Number)?.toDouble()
      val pitch = (options["pitch"] as? Number)?.toDouble()
      HandsfreeCallService.current?.speak(chunks, voiceIdentifier, rate, pitch) ?: false
    }

    AsyncFunction("stopSpeaking") {
      HandsfreeCallService.current?.stopSpeaking()
    }

    AsyncFunction("setMuted") { muted: Boolean ->
      HandsfreeCallService.current?.setMuted(muted)
    }

    AsyncFunction("playSendEarcon") {
      HandsfreeCallService.current?.playSendEarcon()
    }

    AsyncFunction("stopSession") {
      HandsfreeCallService.current?.end("user")
    }
  }

  private fun startService(context: Context, title: String, promise: Promise) {
    try {
      val intent = Intent(context, HandsfreeCallService::class.java)
        .setAction(HandsfreeCallService.ACTION_START)
        .putExtra(HandsfreeCallService.EXTRA_TITLE, title)
      ContextCompat.startForegroundService(context, intent)
      promise.resolve("started")
    } catch (_: Exception) {
      promise.resolve("unavailable")
    }
  }
}
