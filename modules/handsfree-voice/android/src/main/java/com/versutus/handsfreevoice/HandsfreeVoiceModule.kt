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

    AsyncFunction("getAvailability") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.resolve(
          mapOf(
            "recognition" to false,
            "synthesis" to false,
            "maxSpeechInputLength" to 0,
          ),
        )
        return@AsyncFunction
      }
      val recognition = SpeechRecognizer.isRecognitionAvailable(context)
      val maxLength = TextToSpeech.getMaxSpeechInputLength()
      val settled = java.util.concurrent.atomic.AtomicBoolean(false)
      fun settle(synthesis: Boolean) {
        if (settled.compareAndSet(false, true)) {
          promise.resolve(
            mapOf(
              "recognition" to recognition,
              "synthesis" to synthesis,
              "maxSpeechInputLength" to if (synthesis) maxLength else 0,
            ),
          )
        }
      }
      try {
        val engine = TextToSpeech(context) { status ->
          settle(status == TextToSpeech.SUCCESS)
        }
        // A platform that never answers leaves the promise open forever; the
        // module's own timeout is the honest "no synthesis" rather than a hang.
        Handler(Looper.getMainLooper()).postDelayed({
          if (settled.compareAndSet(false, true)) {
            promise.resolve(
              mapOf(
                "recognition" to recognition,
                "synthesis" to false,
                "maxSpeechInputLength" to 0,
              ),
            )
          }
          engine.shutdown()
        }, TTS_PROBE_TIMEOUT_MS)
      } catch (_: Exception) {
        settle(false)
      }
    }

    AsyncFunction("startSession") { title: String, promise: Promise ->
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

  companion object {
    private const val TTS_PROBE_TIMEOUT_MS = 1500L
  }
}
