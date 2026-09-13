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
import java.util.concurrent.atomic.AtomicBoolean

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
      val permissions = appContext.permissions
      if (context == null || permissions == null) {
        promise.resolve("unavailable")
        return@AsyncFunction
      }
      // Only the microphone is required. The notification permission is
      // optional on Android: it is not needed to run a foreground service, and
      // without it the call still shows in Task Manager, so refusing it must
      // not refuse the call.
      val required = arrayOf(Manifest.permission.RECORD_AUDIO)
      val asked = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        required +
          Manifest.permission.POST_NOTIFICATIONS
      } else {
        required
      }
      if (permissions.hasGrantedPermissions(*required)) {
        startService(context, title, promise)
      } else {
        permissions.askForPermissions({ result ->
          val micGranted = result[Manifest.permission.RECORD_AUDIO]?.status == PermissionsStatus.GRANTED
          if (!micGranted) {
            promise.resolve("permission-denied")
          } else {
            // Let the activity resume from the permission dialog before the
            // while-in-use microphone service is created.
            Handler(Looper.getMainLooper()).postDelayed({ startService(context, title, promise) }, RESUME_SETTLE_MS)
          }
        }, *asked)
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
    val settled = AtomicBoolean(false)
    fun settle(outcome: String) {
      if (settled.compareAndSet(false, true)) promise.resolve(outcome)
    }
    HandsfreeCallService.pendingStartCallback = { outcome -> settle(outcome) }
    Handler(Looper.getMainLooper()).postDelayed({
      if (!settled.get()) {
        HandsfreeCallService.pendingStartCallback = null
        // A service that comes up after JS has been told "unavailable" would
        // hold the microphone with nobody driving it; stop it.
        context.stopService(Intent(context, HandsfreeCallService::class.java))
        settle("unavailable")
      }
    }, START_TIMEOUT_MS)
    try {
      val intent = Intent(context, HandsfreeCallService::class.java)
        .setAction(HandsfreeCallService.ACTION_START)
        .putExtra(HandsfreeCallService.EXTRA_TITLE, title)
      ContextCompat.startForegroundService(context, intent)
    } catch (_: Exception) {
      HandsfreeCallService.pendingStartCallback = null
      settle("unavailable")
    }
  }

  companion object {
    private const val START_TIMEOUT_MS = 4000L
    private const val RESUME_SETTLE_MS = 250L
  }
}
