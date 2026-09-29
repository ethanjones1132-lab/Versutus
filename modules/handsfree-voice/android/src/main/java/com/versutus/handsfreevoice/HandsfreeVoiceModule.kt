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
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
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
      "gate",
    )

    OnCreate {
      HandsfreeEventBridge.attach(this@HandsfreeVoiceModule)
    }

    OnDestroy {
      HandsfreeEventBridge.detach()
      gateMedia?.stop()
      gateMedia = null
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
      // The key this attempt's cancellation will name. JS supplies it so an
      // abandoned start can cancel exactly itself; the fallback only covers a
      // caller that never cancels.
      val startId = (options["startId"] as? String)?.trim()?.takeIf { it.isNotEmpty() }
        ?: UUID.randomUUID().toString()
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
      // Claim this attempt before any permission work. A later startSession or
      // a stopSession makes a new attempt the owner, so an answer this one is
      // still waiting on — the OS permission dialog above all — cannot open a
      // microphone behind a newer retry's back.
      HandsfreeCallService.claimStartAttempt(startId)
      if (permissions.hasGrantedPermissions(*required)) {
        startService(context, title, promise, startId)
      } else {
        permissions.askForPermissions({ result ->
          if (!HandsfreeCallService.ownsStartAttempt(startId)) {
            // The JS side abandoned this start and cancelled it, or a newer
            // retry took over while the dialog was up. This answer belongs to
            // no live call and must not start a service.
            promise.resolve("unavailable")
            return@askForPermissions
          }
          val micGranted = result[Manifest.permission.RECORD_AUDIO]?.status == PermissionsStatus.GRANTED
          if (!micGranted) {
            promise.resolve("permission-denied")
          } else {
            // Let the activity resume from the permission dialog before the
            // while-in-use microphone service is created. Ownership is checked
            // again inside startService, because the retry can claim the start
            // during this settle window.
            Handler(Looper.getMainLooper()).postDelayed({ startService(context, title, promise, startId) }, RESUME_SETTLE_MS)
          }
        }, *asked)
      }
    }.runOnQueue(Queues.MAIN)

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

    AsyncFunction("stopSession") { options: Map<String, Any?>? ->
      val startId = (options?.get("startId") as? String)?.trim()?.takeIf { it.isNotEmpty() }
      if (startId == null) {
        // The user's End owns the whole native side, not one attempt: supersede
        // every start still waiting, drop the media socket and end the call.
        HandsfreeCallService.cancelAllStartAttempts()
        gateMedia?.stop()
        gateMedia = null
        HandsfreeCallService.current?.end("user")
      } else if (HandsfreeCallService.cancelStartAttempt(startId)) {
        // This id is still the newest start, so the media belongs to it. The
        // service teardown is keyed AND re-checked when its queued effect
        // executes: a newer retry whose service is already up owns the service
        // by then, and this old cleanup must not end the newer call.
        gateMedia?.stop()
        gateMedia = null
        HandsfreeCallService.current?.endForAttempt(startId, "user")
      }
    }.runOnQueue(Queues.MAIN)

    // ─── Gate media (the phone as the Gate's microphone and speaker) ───────
    AsyncFunction("startGateMedia") { options: Map<String, Any?>, promise: Promise ->
      val context = appContext.reactContext
      val url = (options["url"] as? String)?.trim().orEmpty()
      val token = (options["token"] as? String).orEmpty()
      val voiceSessionId = (options["voiceSessionId"] as? String)?.trim().orEmpty()
      // The attempt this media link belongs to. A delayed start for an
      // abandoned attempt must not stop, or replace, the socket a newer retry
      // owns; the same id a `stopSession` would cancel.
      val startId = (options["startId"] as? String)?.trim()?.takeIf { it.isNotEmpty() }
      if (context == null || url.isEmpty() || voiceSessionId.isEmpty()) {
        promise.resolve(false)
        return@AsyncFunction
      }
      if (startId != null && !HandsfreeCallService.ownsStartAttempt(startId)) {
        promise.resolve(false)
        return@AsyncFunction
      }
      gateMedia?.stop()
      val media = HandsfreeGateMedia { frame ->
        sendEvent("gate", mapOf("frame" to frame))
      }
      gateMedia = media
      media.start(context, url, token, voiceSessionId)
      promise.resolve(true)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("sendGateControl") { json: String ->
      gateMedia?.sendControl(json) ?: false
    }

    AsyncFunction("stopGateMedia") {
      gateMedia?.stop()
      gateMedia = null
    }.runOnQueue(Queues.MAIN)

    // The signed auto-start of §4.4: only the app's own key can sign a
    // `versutus://call` link, so an unsigned link never opens the microphone.
    AsyncFunction("verifyLaunch") { url: String ->
      val context = appContext.reactContext ?: return@AsyncFunction false
      val key = try {
        HandsfreeLaunchKey.loadOrCreateKey(context)
      } catch (_: Exception) {
        return@AsyncFunction false
      }
      HandsfreeLaunchKey.verifyFromKey(key, url, System.currentTimeMillis())
    }
  }

  private var gateMedia: HandsfreeGateMedia? = null

  private fun startService(context: Context, title: String, promise: Promise, startId: String) {
    // A start the JS side abandoned (its deadline ran out and stopSession
    // cancelled it) or a newer retry superseded must not create a service.
    if (!HandsfreeCallService.ownsStartAttempt(startId)) {
      promise.resolve("unavailable")
      return
    }
    val settled = AtomicBoolean(false)
    fun settle(outcome: String) {
      if (settled.compareAndSet(false, true)) promise.resolve(outcome)
    }
    // Arm the answer atomically. If a cancel or a newer claim landed since the
    // check above, this id no longer owns the pending slot, so the start is
    // settled unavailable without arming a callback a newer attempt owns.
    if (!HandsfreeCallService.beginPendingStart(startId) { outcome -> settle(outcome) }) {
      settle("unavailable")
      return
    }
    Handler(Looper.getMainLooper()).postDelayed({
      if (!settled.get()) {
        // Expiry invalidates this attempt's OWNER as well as its pending
        // answer: a stale ACTION_START still queued for a start JS already
        // reported as unavailable must be rejected rather than open a
        // microphone. A newer retry's claim superseded this id, so an old
        // expiry reports false and must never stop the newer service.
        if (HandsfreeCallService.expireStartAttempt(startId)) {
          // A service that comes up after JS has been told "unavailable" would
          // hold the microphone with nobody driving it; stop it.
          context.stopService(Intent(context, HandsfreeCallService::class.java))
        }
        settle("unavailable")
      }
    }, START_TIMEOUT_MS)
    try {
      val intent = Intent(context, HandsfreeCallService::class.java)
        .setAction(HandsfreeCallService.ACTION_START)
        .putExtra(HandsfreeCallService.EXTRA_TITLE, title)
        .putExtra(HandsfreeCallService.EXTRA_START_ID, startId)
      ContextCompat.startForegroundService(context, intent)
    } catch (_: Exception) {
      HandsfreeCallService.expireStartAttempt(startId)
      settle("unavailable")
    }
  }

  companion object {
    private const val START_TIMEOUT_MS = 4000L
    private const val RESUME_SETTLE_MS = 250L
  }
}
