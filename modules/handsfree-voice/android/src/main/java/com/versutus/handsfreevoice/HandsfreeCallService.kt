package com.versutus.handsfreevoice

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.media.SoundPool
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.util.Locale
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * The one Android component that owns a hands-free call's microphone, audio
 * session and user-visible lifetime.
 *
 * It is started only from the visible Start-call tap (the module checks the
 * Activity is resumed and the mic permission is granted first) and promoted
 * immediately to a microphone|mediaPlayback foreground service with an ongoing
 * notification. End is idempotent across the UI, the notification action, task
 * removal, audio-focus loss and teardown, and every path releases recognition,
 * synthesis, the barge-in tap, audio focus and the notification exactly once.
 */
class HandsfreeCallService : Service() {
  private val state = HandsfreeCallState()
  private val mainHandler = Handler(Looper.getMainLooper())

  private var recognizer: SpeechRecognizer? = null
  private var listening = false
  /** True only after [RecognitionListener.onReadyForSpeech]. A posted start is not ready. */
  @Volatile private var readyForSpeech = false

  /** When listening last started (elapsedRealtime), for [HandsfreeFocusPolicy]. */
  private var listenStartedAtMs = 0L
  private var stopRequested = false
  private val endpoints = HandsfreeEndpointing()
  private var currentPartial: String = ""
  private var consecutiveRecognizerFailures = 0
  private var nextChunkIndex = 0

  private var tts: TextToSpeech? = null
  private var ttsWarmAttempted = false
  private var ttsReady = false
  private var speaking = false
  /**
   * True from the moment JS stops recognition to send the turn until the reply
   * is spoken, the reply is skipped, or a new listen begins. It is the wait the
   * notification names "Thinking": the service cannot see the send itself, only
   * that it is no longer hearing and not yet speaking.
   */
  private var thinking = false
  private var speechGeneration = 0L
  private var queuedSpeech = mutableListOf<String>()

  private var audioRecord: AudioRecord? = null
  private var echoCanceler: AcousticEchoCanceler? = null
  private var noiseSuppressor: NoiseSuppressor? = null
  private var vadThread: Thread? = null
  @Volatile private var vadRunning = false
  private var noiseFloor = 0.0
  private var onsetMs = 0L
  private var lastLevelAt = 0L

  private var soundPool: SoundPool? = null
  private var earconId = 0
  private var earconReady = false
  private var pendingEarconAtMs: Long? = null
  private val gateCommitCue = GateCommitCue(::playCommitCueOnMain)

  private var audioFocusRequest: AudioFocusRequest? = null
  private var focused = false
  // The mode and loudspeaker route are applied before focus is requested, so a
  // refused request still leaves them set. Tracked apart from `focused` so the
  // undo runs whether or not focus was granted.
  private var communicationModeApplied = false
  private var audioDeviceCallback: AudioDeviceCallback? = null
  private var requestedCommunicationDeviceId: Int? = null
  private var legacyScoRequested = false

  private var destroyed = false
  private var foregroundStarted = false

  /** The Bot/surface label the operator tapped Start on; a repost keeps it. */
  private var notificationTitle: String = ""

  /**
   * The link that opens this call's own chat, as JS named it when it started
   * the session. Null keeps the notification's tap on the app's launch intent,
   * which is what a build (or a thread) without a link has always done.
   */
  private var notificationOpenUrl: String? = null

  /**
   * The word the Gate itself named for this call (a Gate call's phases live on
   * the Gate, not in the phone recognizer's flags), or null for a phone call
   * and before the Gate's first phase frame.
   */
  private var gateWord: String? = null

  /**
   * True between the Gate media socket failing and the next frame of the new
   * one. It is the notification's "Reconnecting" — the call is still up while
   * its audio link is rebuilt, so it names that rather than a stale phase.
   */
  private var reconnecting = false
  private var capturePaused = false
  private var playbackGap = false

  /** The word last posted, so a repeated Gate frame does not repost. */
  private val notificationWord = HandsfreeCallWord()

  /**
   * When this call started, on the wall clock. Kept across every repost so the
   * notification's chronometer counts from the call's first second instead of
   * resetting each time the body changes.
   */
  private var callStartedAtMs = 0L

  private val audioManager: AudioManager
    get() = getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    // The recognizer the call itself starts takes transient focus, so a loss
    // is judged by when it lands (HandsfreeFocusPolicy). A duck never ends the
    // call; a phone call or another app still does.
    val msSinceListenStart =
      if (listening) SystemClock.elapsedRealtime() - listenStartedAtMs else null
    if (HandsfreeFocusPolicy.endsCall(change, msSinceListenStart)) {
      handleFocusLoss()
    } else if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
      Log.i(TAG, "focus loss ${msSinceListenStart}ms after listen start is the recognizer's own; call continues")
    }
  }

  override fun onCreate() {
    super.onCreate()
    current = this
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_END -> {
        // The notification's End is both halves of End: tell JS (while it is
        // alive) so the reducer reaches its terminal phase and the banner is
        // dismissed, then run the service's own teardown.
        emit("endRequested", mapOf("reason" to "user"))
        end("user")
      }
      // The notification's Mute/Unmute reach the same state the UI's mute
      // control holds: judged against the machine (a mute on an already-ended
      // call is refused like a second End) and reposted so the next label and
      // body follow. The state asked for is `mutedForAction`'s answer, never a
      // value of our own, so the tap reaches the state its label promised.
      // Unmuting does not itself start a turn — the JS reducer decides which
      // phase asks for recognition.
      ACTION_MUTE, ACTION_UNMUTE -> {
        val muted = HandsfreeCallNotification.mutedForAction(intent.action)
        if (muted != null) {
          // Applied on this service's own queue (so the tap mutes the
          // microphone even with no JS runtime listening), then reported: the
          // banner folds the same state through the same path the in-app
          // control takes, and the JS answer's own setMuted is a no-op because
          // this state already holds the value.
          applyMute(muted)
          emit("muteRequest", mapOf("muted" to muted))
        }
      }
      else -> {
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: ""
        val attemptId = intent?.getStringExtra(EXTRA_START_ID)
        val openUrl = intent?.getStringExtra(EXTRA_OPEN_URL)
        startSession(title, attemptId, startId, openUrl)
      }
    }
    return HandsfreeCallState.SERVICE_START_MODE
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // A swipe away ends the call and removes the notification; nothing resumes.
    endFromPlatform("app-killed")
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    endFromPlatform("app-killed")
    current = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  // ── Session start ────────────────────────────────────────────────────────

  /** Opens the session and reports the outcome to the pending start. */
  fun startSession(
    title: String,
    attemptId: String? = null,
    cmdStartId: Int = 0,
    openUrl: String? = null,
  ): Boolean {
    // Every startForegroundService delivery must be promoted before ownership
    // admission. For a duplicate while a call is active, promote its canonical
    // notification rather than replacing that call's title or state.
    val promotionTitle = if (state.isActive) notificationTitle else title
    try {
      val admitted = HandsfreeStartAdmission.admit(
        attemptId = attemptId,
        promote = {
          startForegroundWithNotification(promotionTitle)
          foregroundStarted = true
        },
        owns = HandsfreeCallService::ownsStartAttempt,
        reject = {
          // Rejected starts remove only their temporary notification. A stale
          // delivery must never stop or demote a call that is already active.
          if (!state.isActive) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            foregroundStarted = false
            if (cmdStartId != 0) stopSelf(cmdStartId) else stopSelf()
          }
        },
      )
      if (!admitted) return false
    } catch (error: Exception) {
      // Android 14+ may refuse a microphone service the app is not eligible
      // for. A failed duplicate promotion must not tear down an active call.
      Log.w(TAG, "foreground start refused", error)
      if (attemptId != null) {
        HandsfreeCallService.deliverPendingStart(
          attemptId,
          if (state.isActive) "started" else "unavailable",
        )
      }
      if (!state.isActive) {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        foregroundStarted = false
        if (cmdStartId != 0) stopSelf(cmdStartId) else stopSelf()
      }
      return false
    }
    HandsfreeCallService.noteServiceStart(attemptId)
    if (!state.start()) {
      if (state.isActive) {
        deliverStart("started")
      } else {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        foregroundStarted = false
        deliverStart("unavailable")
        if (cmdStartId != 0) stopSelf(cmdStartId) else stopSelf()
      }
      return false
    }
    HandsfreeGateMediaOwner.beginCall()
    // The Gate media link is owned by the module, not this service: the service
    // watches it for the phases the Gate names and for the socket dying under a
    // call that is still up. Attached for the call's life, across reconnects.
    HandsfreeGateMediaOwner.watch(gateMediaListener)
    notificationTitle = title
    notificationOpenUrl = openUrl?.trim()?.takeIf { it.isNotEmpty() }
    gateWord = null
    reconnecting = false
    capturePaused = false
    playbackGap = false
    notificationWord.reset()
    // One baseline per call: every repost after this keeps the same start, so
    // the call timer counts real call time.
    callStartedAtMs = System.currentTimeMillis()
    thinking = false
    // Refresh the promoted placeholder with the call's canonical initial state
    // after ownership has been admitted, without promoting a second time.
    postNotification()
    requestAudioFocus()
    prepareSendEarcon()
    deliverStart("started")
    return true
  }

  private fun deliverStart(outcome: String) {
    // Only the attempt this service booted for may answer, and only while it
    // still owns the pending slot. The registry makes that one atomic step, so
    // a stale service start cannot answer — or clear — the pending start a
    // newer attempt owns. A null id is the service's own boot with no call.
    val id = HandsfreeCallService.currentServiceAttempt() ?: return
    HandsfreeCallService.deliverPendingStart(id, outcome)
  }

  private fun startForegroundWithNotification(title: String) {
    val notification = buildNotification(title)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun buildNotification(title: String): Notification {
    val endIntent = Intent(this, HandsfreeCallService::class.java).setAction(ACTION_END)
    val endPending = PendingIntent.getService(
      this,
      REQUEST_CODE_END,
      endIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val muteIntent = Intent(this, HandsfreeCallService::class.java)
      .setAction(HandsfreeCallNotification.muteActionFor(state.muted))
    val mutePending = PendingIntent.getService(
      this,
      REQUEST_CODE_MUTE,
      muteIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val caller = Person.Builder()
      .setName(HandsfreeCallNotification.callerFor(title))
      .setImportant(true)
      .build()
    // The timer's baseline is the call's own start, never the repost's, so the
    // chronometer runs on through every phase change.
    val startedAt = if (callStartedAtMs > 0L) callStartedAtMs else System.currentTimeMillis()
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(HandsfreeCallNotification.titleFor(title))
      // State words only: the lock screen says what the call is doing and never
      // shows what was said or who said it.
      .setContentText(stateWord())
      .setOngoing(true)
      .setSilent(true)
      // Reposts change the body line and the timer only; none of them may buzz.
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setWhen(startedAt)
      .setUsesChronometer(true)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .addPerson(caller)
      // Mute/Unmute sits first, labelled with the state the tap will reach, and
      // asks for that state through the service — the label follows what the
      // service holds, never a guess.
      .addAction(0, HandsfreeCallNotification.muteActionLabelFor(state.muted), mutePending)
    contentPending()?.let { builder.setContentIntent(it) }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      // CallStyle draws the notification as an ongoing call: the caller, a
      // running call timer, the Mute action and the system's red Hang up
      // button. The service already runs as a microphone foreground service, so
      // this needs no phoneCall type and no full-screen-intent permission.
      // forOngoingCall accepts up to two custom actions, so Mute fits beside it.
      builder.setStyle(NotificationCompat.CallStyle.forOngoingCall(caller, endPending))
    } else {
      // Before Android 12 there is no call template; End stays a plain, last
      // action so the notification keeps its full control set.
      builder.addAction(0, HandsfreeCallNotification.END_ACTION_LABEL, endPending)
    }
    return builder.build()
  }

  /**
   * Opens the call's own chat when the call notification is tapped.
   *
   * JS names the thread's own link when it starts the session, so the tap lands
   * on the conversation the call is having rather than wherever the app was
   * last left. The link is scoped to this package: it is this app's own
   * `versutus://` vocabulary, so no other app may answer it, and a link this
   * build cannot resolve falls back to the plain launch intent rather than a
   * tap that does nothing.
   */
  private fun contentPending(): PendingIntent? {
    val launch = callChatIntent() ?: packageManager.getLaunchIntentForPackage(packageName) ?: return null
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return PendingIntent.getActivity(
      this,
      REQUEST_CODE_OPEN,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  /** The call thread's own link as a VIEW intent for this app, when one resolves. */
  private fun callChatIntent(): Intent? {
    val url = notificationOpenUrl ?: return null
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(packageName)
    return if (packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY) != null) intent else null
  }

  /**
   * Reposts the ongoing notification as the call stands, so the body line the
   * operator reads while backgrounded follows mute, speech, recognition, the
   * wait between a turn leaving and the reply arriving, the Gate's own phase
   * and a link being rebuilt.
   */
  private fun postNotification() {
    if (!foregroundStarted || destroyed) return
    notificationWord.remember(stateWord())
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(NOTIFICATION_ID, buildNotification(notificationTitle))
  }

  /**
   * The Gate's frames arrive many times a turn and usually name the word that
   * is already shown; only a post that changes the word is worth a redraw.
   */
  private fun postNotificationIfChanged() {
    if (!foregroundStarted || destroyed) return
    if (!notificationWord.changedTo(stateWord())) return
    postNotification()
  }

  /** The body line the notification carries right now. */
  private fun stateWord(): String = HandsfreeCallNotification.bodyFor(
    state.muted,
    listening,
    speaking,
    thinking,
    reconnecting,
    gateWord,
    capturePaused,
    playbackGap,
  )

  // ── The Gate link the service does not own ───────────────────────────────

  /**
   * What the module's Gate media link reports while this call is up.
   *
   * A Gate call runs its loop on the Gate: the phone is its microphone and
   * speaker, and the only evidence of what the call is doing is the frames the
   * Gate sends. They arrive on the socket's own thread, so every one is folded
   * onto this service's queue, where the call's state already lives.
   */
  private val gateMediaListener = object : HandsfreeGateMediaListener {
    override fun onGateFrame(frame: GateFrame) {
      mainHandler.post {
        if (destroyed) return@post
        gateCommitCue.accept(frame)
        HandsfreeCallNotification.wordForGateFrame(frame)?.let { gateWord = it }
        if (frame is GateFrame.Speech) {
          if (frame.state == "start") playbackGap = false
          if (frame.state == "gap") playbackGap = true
        }
        if (frame is GateFrame.Final) playbackGap = false
        // A frame on the socket is the link speaking: whatever was being
        // rebuilt has been rebuilt.
        reconnecting = false
        postNotificationIfChanged()
      }
    }

    override fun onGateLinkLost() {
      mainHandler.post {
        // The call stays up: its notification says the audio link is coming
        // back rather than naming a phase from a socket that is gone.
        if (destroyed || reconnecting) return@post
        reconnecting = true
        capturePaused = false
        playbackGap = false
        postNotificationIfChanged()
      }
    }

    override fun onGateAudioPressure(code: String) {
      mainHandler.post {
        if (destroyed || reconnecting) return@post
        when (code) {
          "capture_backpressure" -> capturePaused = true
          "capture_backpressure_cleared" -> capturePaused = false
          "playback_backpressure" -> playbackGap = true
        }
        postNotificationIfChanged()
      }
    }
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    // An app cannot raise an existing channel's importance. The LOW channel the
    // first build created lands in One UI's silent section, so it is retired.
    manager.deleteNotificationChannel(LEGACY_CHANNEL_ID)
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(CHANNEL_ID, "Hands-free call", NotificationManager.IMPORTANCE_DEFAULT)
    channel.description = "Shown while a hands-free call is active."
    channel.setSound(null, null)
    channel.enableVibration(false)
    manager.createNotificationChannel(channel)
  }

  // ── Audio focus / session mode ───────────────────────────────────────────

  private fun requestAudioFocus() {
    if (focused) return
    audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
    communicationModeApplied = true
    watchAudioDevices()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        )
        .setOnAudioFocusChangeListener(focusListener)
        .build()
      audioFocusRequest = request
      focused = audioManager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    } else {
      @Suppress("DEPRECATION")
      focused = audioManager.requestAudioFocus(
        focusListener,
        AudioManager.STREAM_VOICE_CALL,
        AudioManager.AUDIOFOCUS_GAIN,
      ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }
  }

  private fun releaseAudioFocus() {
    // Focus is abandoned only if it was granted. The mode and route are undone
    // whenever they were applied, so a refused request does not leave the
    // device in communication mode on the loudspeaker.
    if (focused) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        audioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
      } else {
        @Suppress("DEPRECATION")
        audioManager.abandonAudioFocus(focusListener)
      }
    }
    focused = false
    audioFocusRequest = null
    if (communicationModeApplied) {
      audioDeviceCallback?.let { audioManager.unregisterAudioDeviceCallback(it) }
      audioDeviceCallback = null
      releaseCallRoute()
      audioManager.mode = AudioManager.MODE_NORMAL
      communicationModeApplied = false
    }
  }

  private fun watchAudioDevices() {
    if (audioDeviceCallback != null) return
    val callback = object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = updateCallRoute()
      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = updateCallRoute()
    }
    audioDeviceCallback = callback
    audioManager.registerAudioDeviceCallback(callback, mainHandler)
    updateCallRoute()
  }

  @Suppress("DEPRECATION")
  private fun updateCallRoute() {
    if (destroyed || !state.isActive || !communicationModeApplied) return
    val manager = audioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val devices = manager.availableCommunicationDevices
      val currentId = manager.communicationDevice?.id
      val choice = chooseHandsfreeAudioRoute(devices.map { HandsfreeRouteDevice(it.id, it.type) }, currentId)
      val device = devices.firstOrNull { it.id == choice?.id }
      // Set even when it is already the default: keep the requested route as
      // Android's default policy changes during the call.
      if (device != null && requestedCommunicationDeviceId == device.id && currentId == device.id) return
      if (device != null && manager.setCommunicationDevice(device)) {
        requestedCommunicationDeviceId = device.id
      } else {
        requestedCommunicationDeviceId = null
        manager.clearCommunicationDevice()
        if (manager.communicationDevice == null && device == null) {
          emit("fatalError", mapOf("reason" to "media-failed"))
          end("media-failed")
        }
      }
    } else {
      val scoAvailable = manager.isBluetoothScoAvailableOffCall
      val devices = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        .filter { scoAvailable || it.type != AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
      val choice = chooseHandsfreeAudioRoute(devices.map { HandsfreeRouteDevice(it.id, it.type) })
      if (choice?.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) {
        manager.isSpeakerphoneOn = false
        if (!legacyScoRequested) {
          manager.startBluetoothSco()
          manager.isBluetoothScoOn = true
          legacyScoRequested = true
        }
      } else {
        releaseLegacySco()
        manager.isSpeakerphoneOn = choice?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun releaseLegacySco() {
    if (!legacyScoRequested) return
    audioManager.isBluetoothScoOn = false
    audioManager.stopBluetoothSco()
    legacyScoRequested = false
  }

  private fun releaseCallRoute() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audioManager.clearCommunicationDevice()
      requestedCommunicationDeviceId = null
    } else {
      releaseLegacySco()
      @Suppress("DEPRECATION")
      audioManager.isSpeakerphoneOn = false
    }
  }

  private fun handleFocusLoss() {
    // A transient loss is not silently recovered into: another app or a phone
    // call has the audio, and the operator must Start again.
    emit("interruption", mapOf("reason" to "audio-focus"))
    end("system-interruption")
  }

  // ── Recognition ──────────────────────────────────────────────────────────

  fun startListening(): Boolean {
    if (!state.isActive || state.muted) return false
    // The recognizer is ready only once onReadyForSpeech has fired. Returning
    // true on the post made the banner say Listening while a cold bind still
    // had nothing consuming the microphone.
    if (listening && readyForSpeech) return true
    if (!listening) mainHandler.post { startListeningInternal() }
    return false
  }

  private fun ensureRecognizer(): SpeechRecognizer? {
    recognizer?.let { return it }
    val onDevice = PREFER_ON_DEVICE_RECOGNIZER &&
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
      SpeechRecognizer.isOnDeviceRecognitionAvailable(this)
    val created = when {
      onDevice -> SpeechRecognizer.createOnDeviceSpeechRecognizer(this)
      SpeechRecognizer.isRecognitionAvailable(this) -> SpeechRecognizer.createSpeechRecognizer(this)
      else -> null
    } ?: return null
    Log.i(TAG, "recognizer bound (onDevice=$onDevice)")
    created.setRecognitionListener(recognitionListener)
    recognizer = created
    return created
  }

  private fun destroyRecognizer() {
    try {
      recognizer?.destroy()
    } catch (_: Exception) {
    }
    recognizer = null
  }

  private fun startListeningInternal() {
    if (!state.isActive || state.muted || listening) return
    readyForSpeech = false
    val engine = ensureRecognizer()
    if (engine == null) {
      emit("fatalError", mapOf("reason" to "recognition-failed", "message" to "recognition-unavailable"))
      end("recognition-failed")
      return
    }
    stopRequested = false
    listening = true
    // A new listen ends the turn-in-flight wait the body called "Thinking".
    thinking = false
    currentPartial = ""
    listenStartedAtMs = SystemClock.elapsedRealtime()
    endpoints.begin(listenStartedAtMs)
    try {
      engine.startListening(buildRecognizerIntent())
      // Only the phone engine uses this recognizer. Bind its voice while the
      // user is speaking, without holding Listening for the service callback
      // or sending a dummy utterance to a potentially network-backed engine.
      if (!ttsWarmAttempted) {
        ttsWarmAttempted = true
        runCatching { ensureTts() }.onFailure { Log.w(TAG, "phone TTS warm-up could not bind") }
      }
      postNotification()
      scheduleTick()
    } catch (error: Exception) {
      listening = false
      readyForSpeech = false
      emit("fatalError", mapOf("reason" to "recognition-failed", "message" to error.message))
      end("recognition-failed")
    }
  }

  private fun buildRecognizerIntent(): Intent =
    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
      putExtra(
        RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS,
        HandsfreeEndpointing.COMPLETE_SILENCE_MS,
      )
      putExtra(
        RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS,
        HandsfreeEndpointing.POSSIBLY_COMPLETE_SILENCE_MS,
      )
      putExtra(
        RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS,
        HandsfreeEndpointing.MINIMUM_SPEECH_MS,
      )
    }

  /**
   * Stops recognizing without delivering a result. Used before a send and on
   * teardown, where a late `onResults` would fabricate an unwanted turn.
   */
  fun stopListening() {
    mainHandler.post {
      stopRequested = true
      listening = false
      readyForSpeech = false
      // JS stops recognition when it sends the turn: the call is no longer
      // hearing and not yet speaking, which is the wait the body names
      // "Thinking".
      thinking = true
      cancelTick()
      postNotification()
      try {
        recognizer?.cancel()
      } catch (_: Exception) {
      }
    }
  }

  private val recognitionListener = object : RecognitionListener {
    override fun onReadyForSpeech(params: android.os.Bundle?) {
      readyForSpeech = true
    }
    override fun onBeginningOfSpeech() {
      endpoints.onVoice(SystemClock.elapsedRealtime())
    }

    override fun onRmsChanged(rmsdB: Float) {
      if (rmsdB > VOICE_RMS_DB) endpoints.onVoice(SystemClock.elapsedRealtime())
      emitLevel(((rmsdB + 2f) / 12f).coerceIn(0f, 1f).toDouble())
    }

    override fun onBufferReceived(buffer: ByteArray?) {}

    override fun onEndOfSpeech() {}

    override fun onError(error: Int) {
      listening = false
      readyForSpeech = false
      cancelTick()
      if (stopRequested) {
        stopRequested = false
        return
      }
      val action = HandsfreeRecognizerErrors.classify(error, consecutiveRecognizerFailures)
      Log.i(TAG, "recognizer error $error -> $action (failures=$consecutiveRecognizerFailures)")
      when (action) {
        HandsfreeRecognizerErrors.Action.RESTART -> {
          emit("noSpeech", mapOf("reason" to "silence"))
          restartIfActive()
        }
        HandsfreeRecognizerErrors.Action.RETRY_LATER -> {
          consecutiveRecognizerFailures += 1
          // A recognizer that lost its network is rebuilt rather than reused.
          if (error != SpeechRecognizer.ERROR_RECOGNIZER_BUSY) destroyRecognizer()
          mainHandler.postDelayed({ restartIfActive() }, BUSY_RETRY_MS * consecutiveRecognizerFailures)
        }
        HandsfreeRecognizerErrors.Action.FATAL -> {
          emit("fatalError", mapOf("reason" to "recognition-failed", "message" to "recognizer-error-$error"))
          end("recognition-failed")
        }
      }
    }

    override fun onResults(results: android.os.Bundle?) {
      consecutiveRecognizerFailures = 0
      listening = false
      readyForSpeech = false
      cancelTick()
      if (stopRequested) {
        stopRequested = false
        return
      }
      val text = bestResult(results).trim()
      if (text.isNotEmpty()) {
        emit("final", mapOf("text" to text))
      } else {
        emit("noSpeech", mapOf("reason" to "silence"))
      }
      // Restart immediately: the JS grace window can only cancel a pending
      // send in favour of a resumed utterance if the recognizer is already
      // listening again. Restart latency otherwise clips the first syllables.
      restartIfActive()
    }

    override fun onPartialResults(partialResults: android.os.Bundle?) {
      consecutiveRecognizerFailures = 0
      val text = bestResult(partialResults).trim()
      if (text.isEmpty() || text == currentPartial) return
      currentPartial = text
      endpoints.onVoice(SystemClock.elapsedRealtime())
      emit("partial", mapOf("text" to text))
    }

    override fun onEvent(eventType: Int, params: android.os.Bundle?) {}
  }

  private fun bestResult(bundle: android.os.Bundle?): String {
    val list = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) ?: return ""
    return list.firstOrNull() ?: ""
  }

  private fun restartIfActive() {
    if (!state.isActive || state.muted || destroyed) return
    mainHandler.post { startListeningInternal() }
  }

  // ── Per-turn timers ──────────────────────────────────────────────────────

  private val tick = object : Runnable {
    override fun run() {
      if (!listening) return
      val now = SystemClock.elapsedRealtime()
      if (endpoints.isPastCeiling(now)) {
        if (endpoints.hasHeardSpeech()) {
          // Close the turn at the platform level; onResults carries the words.
          try {
            recognizer?.stopListening()
          } catch (_: Exception) {
          }
          mainHandler.postDelayed(this, TICK_MS)
        } else {
          listening = false
          emit("noSpeech", mapOf("reason" to "ceiling"))
          restartIfActive()
        }
        return
      }
      if (endpoints.shouldFinishForSilence(now)) {
        try {
          recognizer?.stopListening()
        } catch (_: Exception) {
        }
      }
      mainHandler.postDelayed(this, TICK_MS)
    }
  }

  private fun scheduleTick() {
    mainHandler.removeCallbacks(tick)
    mainHandler.postDelayed(tick, TICK_MS)
  }

  private fun cancelTick() {
    mainHandler.removeCallbacks(tick)
  }

  // ── Speech ───────────────────────────────────────────────────────────────

  fun speak(chunks: List<String>, voiceIdentifier: String?, rate: Double?, pitch: Double?): Boolean {
    // Refused here as well as in the posted block: an End that already tore the
    // service down has no TTS left to speak through, and JS is told `false`
    // rather than an acceptance nothing will carry out. The block's own check
    // is the one that binds — this thread's read of `destroyed` is not ordered.
    if (!state.canSpeak(destroyed)) return false
    val usable = chunks.filter { it.isNotBlank() }
    if (usable.isEmpty()) return false
    mainHandler.post { speakInternal(usable, voiceIdentifier, rate, pitch) }
    return true
  }

  private fun ensureTts(): TextToSpeech {
    tts?.let { return it }
    val created = TextToSpeech(this) { status ->
      mainHandler.post {
        // A cold engine can finish binding after the call ended; the teardown
        // released everything, and this must not mark an engine ready or speak
        // a queued sentence against a call that no longer exists.
        if (destroyed) return@post
        ttsReady = status == TextToSpeech.SUCCESS
        if (!ttsReady) {
          if (speaking) {
            speaking = false
            stopBargeIn()
            emit("fatalError", mapOf("reason" to "speech-failed", "message" to "tts-init-$status"))
            end("speech-failed")
          } else {
            // A background warm-up must not strand the real first sentence
            // behind a binding that already failed.
            runCatching { tts?.shutdown() }
            tts = null
          }
          return@post
        }
        configureTts()
        val engine = tts ?: return@post
        // Sentences queued while a cold engine was still binding play now,
        // instead of failing against an unbound engine.
        if (speaking && nextChunkIndex < queuedSpeech.size) playChunk(engine, speechGeneration, nextChunkIndex)
      }
    }
    created.setOnUtteranceProgressListener(utteranceListener)
    tts = created
    return created
  }

  private var pendingVoiceIdentifier: String? = null
  private var pendingRate: Double? = null
  private var pendingPitch: Double? = null

  private fun configureTts() {
    val engine = tts ?: return
    engine.language = Locale.getDefault()
    pendingVoiceIdentifier?.let { identifier ->
      engine.voices?.firstOrNull { it.name == identifier }?.let { engine.voice = it }
    }
    pendingRate?.let { engine.setSpeechRate(it.toFloat()) }
    pendingPitch?.let { engine.setPitch(it.toFloat()) }
  }

  private fun speakInternal(chunks: List<String>, voiceIdentifier: String?, rate: Double?, pitch: Double?) {
    // The post above can land after End ran its teardown, and this is the one
    // entry point that rebuilds what teardown released: without the guard a
    // reply that was streaming when the operator tapped End re-creates the TTS
    // engine, re-opens the barge-in microphone and speaks on after the call is
    // over — with nothing left to release it. Same check `startListeningInternal`
    // makes, for the same reason.
    if (!state.canSpeak(destroyed)) return
    // Recognition must be off before speech so the reply is not heard back.
    if (listening) stopListening()
    pendingVoiceIdentifier = voiceIdentifier
    pendingRate = rate
    pendingPitch = pitch
    val engine = ensureTts()
    if (speaking) {
      // Progressive speech: later sentences of the same reply join the queue
      // rather than starting a new generation that abandons the earlier ones.
      queuedSpeech.addAll(chunks)
      return
    }
    speechGeneration += 1
    speaking = true
    // The reply is here: the wait that read "Thinking" is over.
    thinking = false
    queuedSpeech = chunks.toMutableList()
    nextChunkIndex = 0
    startBargeIn()
    postNotification()
    if (ttsReady) {
      configureTts()
      playChunk(engine, speechGeneration, 0)
    }
  }

  private fun playChunk(engine: TextToSpeech, generation: Long, index: Int) {
    // A teardown between an utterance finishing and its successor starting must
    // not speak, and must not emit `speechFinished` for a call JS has ended.
    if (destroyed) return
    if (generation != speechGeneration) return
    nextChunkIndex = index
    if (index >= queuedSpeech.size) {
      speaking = false
      // The reply finished; the call is not waiting on a turn any more — the
      // next thing it does is listen, and JS says so when it does.
      thinking = false
      stopBargeIn()
      postNotification()
      emit("speechFinished", mapOf("reason" to "done"))
      return
    }
    val utteranceId = "$generation:$index"
    engine.speak(queuedSpeech[index], TextToSpeech.QUEUE_ADD, null, utteranceId)
  }

  private val utteranceListener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String?) {}
    override fun onError(utteranceId: String?) {
      mainHandler.post {
        if (destroyed) return@post
        if (!speaking) return@post
        speaking = false
        stopBargeIn()
        emit("fatalError", mapOf("reason" to "speech-failed", "message" to "tts-error"))
        end("speech-failed")
      }
    }

    override fun onDone(utteranceId: String?) {
      mainHandler.post {
        if (destroyed) return@post
        val parts = utteranceId?.split(":")
        if (parts == null || parts.size != 2) return@post
        val generation = parts[0].toLongOrNull() ?: return@post
        val index = parts[1].toIntOrNull() ?: return@post
        if (generation != speechGeneration) return@post
        val engine = tts ?: return@post
        playChunk(engine, generation, index + 1)
      }
    }

    @Deprecated("Deprecated in Java")
    override fun onError(utteranceId: String?, errorCode: Int) {
      onError(utteranceId)
    }
  }

  fun stopSpeaking() {
    mainHandler.post {
      speechGeneration += 1
      speaking = false
      thinking = false
      queuedSpeech.clear()
      stopBargeIn()
      postNotification()
      try {
        tts?.stop()
      } catch (_: Exception) {
      }
    }
  }

  fun playSendEarcon() {
    mainHandler.post { playCommitCueOnMain() }
  }

  private fun prepareSendEarcon() {
    if (destroyed || soundPool != null) return
    try {
      val pool = SoundPool.Builder()
        .setMaxStreams(1)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build(),
        )
        .build()
      soundPool = pool
      pool.setOnLoadCompleteListener { sender, sampleId, status ->
        if (destroyed || sender !== soundPool || sampleId != earconId) return@setOnLoadCompleteListener
        earconReady = status == 0
        val requested = pendingEarconAtMs
        pendingEarconAtMs = null
        if (earconReady && requested != null && SystemClock.elapsedRealtime() - requested <= 300L) {
          playCommitCueOnMain()
        }
      }
      earconId = pool.load(this, R.raw.handsfree_send_earcon, 1)
    } catch (_: Exception) {
      // A refused cue doesn't interrupt audio or the call.
    }
  }

  private fun playCommitCueOnMain() {
    if (destroyed) return
    if (!earconReady) {
      pendingEarconAtMs = SystemClock.elapsedRealtime()
      return
    }
    try {
      val stream = soundPool?.play(earconId, 1f, 1f, 1, 0, 1f) ?: 0
      if (stream != 0) Log.d(TAG, "call commit cue queued")
    } catch (_: Exception) {
    }
  }

  // ── Barge-in voice-activity detection ────────────────────────────────────

  private fun startBargeIn() {
    // Opening the microphone is the one thing a late speech effect must never
    // do: teardown released the tap, and nothing but teardown, a barge-in or the
    // tap's own give-up would ever close one opened here.
    if (destroyed) return
    if (vadRunning) return
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    val sampleRate = VAD_SAMPLE_RATE
    val minBuffer = AudioRecord.getMinBufferSize(
      sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    if (minBuffer <= 0) return
    val record = try {
      AudioRecord(
        MediaRecorder.AudioSource.VOICE_COMMUNICATION,
        sampleRate,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        minBuffer * 2,
      )
    } catch (_: Exception) {
      return
    }
    if (record.state != AudioRecord.STATE_INITIALIZED) {
      record.release()
      return
    }
    audioRecord = record
    // Same effects the Gate media path attaches: without them the loudspeaker
    // TTS is heard as barge-in and every reply is truncated mid-word.
    if (AcousticEchoCanceler.isAvailable()) {
      echoCanceler = AcousticEchoCanceler.create(record.audioSessionId)?.also { it.enabled = true }
    }
    if (NoiseSuppressor.isAvailable()) {
      noiseSuppressor = NoiseSuppressor.create(record.audioSessionId)?.also { it.enabled = true }
    }
    vadRunning = true
    // Keep an adapted floor across replies. Reseeding from 0 made the first
    // pre-speech sample the floor, so TTS crossed the onset on every sentence.
    onsetMs = 0L
    lastLevelAt = 0L
    record.startRecording()
    val thread = Thread {
      val buffer = ShortArray(VAD_BLOCK_SAMPLES)
      var failedReads = 0
      try {
        while (vadRunning) {
          val read = try {
            record.read(buffer, 0, buffer.size)
          } catch (_: Exception) {
            -1
          }
          if (read <= 0) {
            // A record whose mic was taken, or that lost focus, fails every
            // read at once, so spinning on it would burn the CPU for the rest
            // of the call while the barge-in tap can hear nothing anyway.
            Thread.sleep(READ_FAILURE_BACKOFF_MS)
            failedReads += 1
            if (failedReads >= MAX_CONSECUTIVE_READ_FAILURES) {
              vadRunning = false
              break
            }
            continue
          }
          failedReads = 0
          var sum = 0.0
          for (i in 0 until read) {
            val sample = buffer[i].toDouble()
            sum += sample * sample
          }
          val rms = sqrt(sum / read)
          val level = (rms / 32768.0).coerceIn(0.0, 1.0)
          val now = SystemClock.elapsedRealtime()
          if (noiseFloor == 0.0) noiseFloor = MIN_FLOOR
          noiseFloor = noiseFloor * (1 - FLOOR_ADAPT) + level * FLOOR_ADAPT
          val threshold = maxOf(noiseFloor * ONSET_FACTOR, MIN_FLOOR)
          if (level > threshold) {
            if (onsetMs == 0L) onsetMs = now
            if (now - onsetMs >= ONSET_HOLD_MS) {
              onsetMs = 0L
              mainHandler.post { handleBargeIn() }
              break
            }
          } else {
            onsetMs = 0L
          }
          if (now - lastLevelAt >= LEVEL_INTERVAL_MS) {
            lastLevelAt = now
            emitLevel(level)
          }
        }
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      } catch (_: Exception) {
        // A released AudioRecord throws here; the tap is already torn down.
      }
    }
    thread.isDaemon = true
    vadThread = thread
    thread.start()
  }

  private fun handleBargeIn() {
    // A tap post can still be queued when the call ends; the onset belongs to
    // speech, and there is none to interrupt afterwards.
    if (destroyed || !speaking) return
    // Flush the queue through the same path stopSpeaking uses, then report.
    speechGeneration += 1
    speaking = false
    queuedSpeech.clear()
    stopBargeIn()
    try {
      tts?.stop()
    } catch (_: Exception) {
    }
    emit("bargeIn", mapOf("reason" to "voice-onset"))
  }

  private fun stopBargeIn() {
    vadRunning = false
    echoCanceler?.release()
    echoCanceler = null
    noiseSuppressor?.release()
    noiseSuppressor = null
    val record = audioRecord
    audioRecord = null
    try {
      record?.stop()
    } catch (_: Exception) {
    }
    try {
      record?.release()
    } catch (_: Exception) {
    }
    vadThread = null
  }

  // ── Muting ───────────────────────────────────────────────────────────────

  fun setMuted(muted: Boolean) {
    mainHandler.post { applyMute(muted) }
  }

  private fun applyMute(muted: Boolean) {
    if (!state.setMuted(muted)) return
    HandsfreeGateMediaOwner.setMuted(muted)
    // The phase word the Gate last named belongs to the state the operator
    // just left: after Unmute the body must not keep claiming "Muted" until
    // the Gate names the next phase on its own.
    if (!muted) gateWord = null
    if (muted) {
      listening = false
      cancelTick()
      try {
        recognizer?.cancel()
      } catch (_: Exception) {
      }
    }
    postNotification()
    // Unmuting does not itself start a turn: the JS reducer decides which
    // phase the call is in and asks for recognition when it is listening.
  }

  // ── Terminal transition ──────────────────────────────────────────────────

  fun end(reason: String) {
    mainHandler.post {
      if (!state.requestEnd(reason)) return@post
      teardown()
    }
  }

  /**
   * Ends a call the platform took away rather than one the operator asked to
   * end — task removed, service destroyed — telling JS first while its runtime
   * may still be alive. [end] emits nothing, and a JS runtime that outlives the
   * service (the OS reclaimed the foreground microphone service) has no probe
   * and no timer to notice: without this event the banner keeps showing
   * "Listening" with Mute/Skip/End that do nothing, for the rest of the app's
   * life.
   *
   * The same [HandsfreeCallState.requestEnd] that ends the call decides whether
   * to speak, so there is no new flag to keep in step: the first end wins, and a
   * call the operator (or focus loss) already ended is never announced twice.
   */
  private fun endFromPlatform(reason: String) {
    mainHandler.post {
      if (!state.requestEnd(reason)) return@post
      try {
        emit("endRequested", mapOf("reason" to reason))
      } catch (_: Exception) {
        // No JS runtime is listening here in the common case, and one that
        // cannot take the event must not stop the teardown below.
      }
      teardown()
    }
  }

  /**
   * Ends the call only if the service still booted for [attemptId]. A module
   * cleanup queues this when JS abandons ONE attempt; by the time it runs a
   * newer retry may already own the service, and a queued old teardown must
   * not end the newer call. The re-check happens here, when the post actually
   * executes, on the same main thread that processes `ACTION_START`, not only
   * when the cleanup was issued. Deliberately keyed: this is never the user's
   * End, which owns the whole native side and goes through [end].
   */
  fun endForAttempt(attemptId: String, reason: String) {
    mainHandler.post {
      if (!HandsfreeCallService.servesStartAttempt(attemptId)) return@post
      if (!state.requestEnd(reason)) return@post
      teardown()
    }
  }

  private fun teardown() {
    // One-shot, and now genuinely so: every path that could rebuild what this
    // releases — speak, a binding TTS engine, the barge-in tap, the earcon pool
    // — refuses once `destroyed` is set, so a late one has nothing to undo and a
    // second pass has nothing left to do.
    if (destroyed) return
    destroyed = true
    // stop() clears the owner's listener too: the call whose phases it named is
    // over, and a lingering one would take the next media instance's frames.
    HandsfreeGateMediaOwner.stop()
    gateWord = null
    reconnecting = false
    notificationOpenUrl = null
    notificationWord.reset()
    listening = false
    readyForSpeech = false
    stopRequested = false
    cancelTick()
    try {
      recognizer?.cancel()
    } catch (_: Exception) {
    }
    try {
      recognizer?.destroy()
    } catch (_: Exception) {
    }
    recognizer = null
    stopBargeIn()
    speechGeneration += 1
    speaking = false
    thinking = false
    callStartedAtMs = 0L
    queuedSpeech.clear()
    try {
      tts?.stop()
    } catch (_: Exception) {
    }
    try {
      tts?.shutdown()
    } catch (_: Exception) {
    }
    tts = null
    ttsReady = false
    try {
      soundPool?.release()
    } catch (_: Exception) {
    }
    soundPool = null
    releaseAudioFocus()
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    foregroundStarted = false
    HandsfreeCallService.clearService()
    stopSelf()
  }

  // ── Events ───────────────────────────────────────────────────────────────

  private fun emit(name: String, body: Map<String, Any?>) {
    HandsfreeEventBridge.emit(name, body)
  }

  private fun emitLevel(level: Double) {
    if (destroyed) return
    HandsfreeEventBridge.emit("level", mapOf("level" to level))
  }

  companion object {
    const val ACTION_START = "com.versutus.handsfreevoice.action.START"
    const val ACTION_END = "com.versutus.handsfreevoice.action.END"
    const val ACTION_MUTE = "com.versutus.handsfreevoice.action.MUTE"
    const val ACTION_UNMUTE = "com.versutus.handsfreevoice.action.UNMUTE"
    const val EXTRA_TITLE = "com.versutus.handsfreevoice.extra.TITLE"
    const val EXTRA_START_ID = "com.versutus.handsfreevoice.extra.START_ID"
    // The call's own chat, as a `versutus://` link. Optional: a session started
    // without one keeps the notification's tap on the app's launch intent.
    const val EXTRA_OPEN_URL = "com.versutus.handsfreevoice.extra.OPEN_URL"
    // Distinct request codes: one PendingIntent per action, so the Mute intent
    // never overwrites the End intent's tap.
    private const val REQUEST_CODE_END = 8402
    private const val REQUEST_CODE_MUTE = 8403
    // The content tap opens the app; its own code so it can never be handed the
    // Mute or End intent.
    private const val REQUEST_CODE_OPEN = 8404
    private const val CHANNEL_ID = "handsfree-call-v2"
    private const val LEGACY_CHANNEL_ID = "handsfree-call"
    /** Flip after the device matrix if Samsung's default recognizer misbehaves. */
    private const val PREFER_ON_DEVICE_RECOGNIZER = false
    private const val NOTIFICATION_ID = 8401
    private const val TICK_MS = 200L
    private const val BUSY_RETRY_MS = 400L
    private const val VAD_SAMPLE_RATE = 16000
    private const val VAD_BLOCK_SAMPLES = 1600
    private const val VOICE_RMS_DB = 0.5f
    private const val ONSET_HOLD_MS = 250L
    private const val LEVEL_INTERVAL_MS = 100L
    private const val FLOOR_ADAPT = 0.02
    private const val ONSET_FACTOR = 3.0
    private const val MIN_FLOOR = 0.01
    /** Backoff between failed reads, and the run of them that ends the tap. */
    private const val READ_FAILURE_BACKOFF_MS = 10L
    private const val MAX_CONSECUTIVE_READ_FAILURES = 100

    private const val TAG = "HandsfreeCallService"

    /**
     * Who owns the current start, and the one answer it is still owed. The
     * module claims a JS-generated id before any permission work, so an answer
     * an abandoned attempt is still waiting for — the OS permission dialog
     * above all — cannot open a microphone behind the newer attempt's back.
     */
    private val ownership = HandsfreeStartOwnership()

    /** Claims [id] as the newest start, superseding every earlier one. */
    fun claimStartAttempt(id: String): Boolean = ownership.claim(id)

    /** True while [id] is the newest start and has not been cancelled. */
    fun ownsStartAttempt(id: String): Boolean = ownership.owns(id)

    /**
     * Arms the answer for [id]'s foreground start. False when [id] no longer
     * owns the start, so the caller settles it as unavailable instead.
     */
    fun beginPendingStart(id: String, callback: (String) -> Unit): Boolean =
      ownership.beginPending(id, callback)

    /** Answers [id]'s pending start exactly once; false when it no longer owns it. */
    fun deliverPendingStart(id: String, outcome: String): Boolean =
      ownership.deliver(id, outcome)

    /**
     * Gives up on [id] because its module timer ran out, invalidating BOTH its
     * ownership and its pending answer. A stale `ACTION_START` still queued for
     * a start JS already reported as unavailable must be rejected rather than
     * admitted. A newer retry's claim moved ownership on, so an old expiry
     * reports false and must never stop the newer service.
     */
    fun expireStartAttempt(id: String): Boolean = ownership.expire(id)

    /**
     * Cancels exactly [id] if it is the newest start. A cleanup whose id has
     * been superseded cancels nothing, so an old cancel can never invalidate —
     * or end — a newer attempt.
     */
    fun cancelStartAttempt(id: String): Boolean = ownership.cancel(id)

    /**
     * Supersedes every start. The user's End owns the whole native side rather
     * than one attempt, so it uses this instead of a keyed cancel.
     */
    fun cancelAllStartAttempts(): Boolean = ownership.cancelAll()

    /** Records the attempt the service actually booted for (null = no call). */
    fun noteServiceStart(id: String?) = ownership.noteServiceStart(id)

    /** The attempt the service currently booted for, or null when none. */
    fun currentServiceAttempt(): String? = ownership.currentService()

    /** True while the service still booted for [id]; rechecked at teardown time. */
    fun servesStartAttempt(id: String): Boolean = ownership.servesService(id)

    /** Clears the service owner once the call has torn down. */
    fun clearService() = ownership.clearService()

    @Volatile
    var current: HandsfreeCallService? = null
      private set
  }
}

/**
 * The single native-to-JS event seam. The module attaches itself on create and
 * detaches on destroy; the service (which outlives a JS reload only as far as
 * the process does) emits through whatever is attached. An event emitted with
 * no runtime present is dropped — the recovery layer covers that case.
 */
internal object HandsfreeEventBridge {
  @Volatile
  private var emitter: ((String, Map<String, Any?>) -> Unit)? = null

  fun attach(module: HandsfreeVoiceModule) {
    emitter = { name, body -> module.sendEvent(name, body) }
  }

  fun detach() {
    emitter = null
  }

  fun emit(name: String, body: Map<String, Any?> = emptyMap()) {
    emitter?.invoke(name, body)
  }
}
