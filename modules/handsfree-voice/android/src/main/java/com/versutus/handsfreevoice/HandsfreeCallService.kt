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
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.SoundPool
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
  private var stopRequested = false
  private val endpoints = HandsfreeEndpointing()
  private var currentPartial: String = ""
  private var consecutiveRecognizerFailures = 0
  private var nextChunkIndex = 0

  private var tts: TextToSpeech? = null
  private var ttsReady = false
  private var speaking = false
  private var speechGeneration = 0L
  private var queuedSpeech = mutableListOf<String>()

  private var audioRecord: AudioRecord? = null
  private var vadThread: Thread? = null
  @Volatile private var vadRunning = false
  private var noiseFloor = 0.0
  private var onsetMs = 0L
  private var lastLevelAt = 0L

  private var soundPool: SoundPool? = null
  private var earconId = 0

  private var audioFocusRequest: AudioFocusRequest? = null
  private var focused = false

  private var destroyed = false
  private var foregroundStarted = false

  /** The Bot/surface label the operator tapped Start on; a repost keeps it. */
  private var notificationTitle: String = ""

  private val audioManager: AudioManager
    get() = getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> handleFocusLoss()
      // A notification chime or a navigation prompt ducks the call; it is not a
      // reason to end it. A phone call still ends it (the product contract says
      // a call never resumes itself after a system call).
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> Unit
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
      // body follow. Unmuting does not itself start a turn — the JS reducer
      // decides which phase asks for recognition.
      ACTION_MUTE, ACTION_UNMUTE -> {
        val muted = HandsfreeCallNotification.mutedForAction(intent.action)
        if (muted != null) setMuted(muted)
      }
      else -> {
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: ""
        startSession(title)
      }
    }
    return HandsfreeCallState.SERVICE_START_MODE
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // A swipe away ends the call and removes the notification; nothing resumes.
    end("app-killed")
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    end("app-killed")
    current = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  // ── Session start ────────────────────────────────────────────────────────

  /** Opens the session and reports the outcome to the pending start. */
  fun startSession(title: String): Boolean {
    if (!state.start()) {
      deliverStart(if (state.isActive) "started" else "unavailable")
      return false
    }
    notificationTitle = title
    try {
      startForegroundWithNotification(title)
      foregroundStarted = true
    } catch (error: Exception) {
      // Android 14+ refuses a microphone service the app is not eligible for
      // (ForegroundServiceStartNotAllowedException / SecurityException). An
      // uncaught throw here would kill the process; it is reported instead.
      Log.w(TAG, "foreground start refused", error)
      state.requestEnd("start-refused")
      deliverStart("unavailable")
      stopSelf()
      return false
    }
    requestAudioFocus()
    deliverStart("started")
    return true
  }

  private fun deliverStart(outcome: String) {
    val callback = pendingStartCallback
    pendingStartCallback = null
    callback?.invoke(outcome)
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
      .setAction(if (state.muted) ACTION_UNMUTE else ACTION_MUTE)
    val mutePending = PendingIntent.getService(
      this,
      REQUEST_CODE_MUTE,
      muteIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(HandsfreeCallNotification.titleFor(title))
      .setContentText(HandsfreeCallNotification.bodyFor(state.muted, listening, speaking))
      .setOngoing(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      // End stays the terminal action, last; Mute/Unmute sits first, labelled
      // with the state the tap will reach, and asks for that state through the
      // service — the label follows what the service holds, never a guess.
      .addAction(0, HandsfreeCallNotification.muteActionLabelFor(state.muted), mutePending)
      .run {
        addAction(0, HandsfreeCallNotification.END_ACTION_LABEL, endPending)
        build()
      }
  }

  /**
   * Reposts the ongoing notification as the call stands, so the body line the
   * operator reads while backgrounded follows mute, speech and recognition.
   */
  private fun postNotification() {
    if (!foregroundStarted || destroyed) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(NOTIFICATION_ID, buildNotification(notificationTitle))
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
    if (!focused) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      audioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
    } else {
      @Suppress("DEPRECATION")
      audioManager.abandonAudioFocus(focusListener)
    }
    focused = false
    audioFocusRequest = null
    audioManager.mode = AudioManager.MODE_NORMAL
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
    mainHandler.post { startListeningInternal() }
    return true
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
    val engine = ensureRecognizer()
    if (engine == null) {
      emit("fatalError", mapOf("reason" to "recognition-failed", "message" to "recognition-unavailable"))
      end("recognition-failed")
      return
    }
    stopRequested = false
    listening = true
    currentPartial = ""
    endpoints.begin(SystemClock.elapsedRealtime())
    try {
      engine.startListening(buildRecognizerIntent())
      postNotification()
      scheduleTick()
    } catch (error: Exception) {
      listening = false
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
      cancelTick()
      postNotification()
      try {
        recognizer?.cancel()
      } catch (_: Exception) {
      }
    }
  }

  private val recognitionListener = object : RecognitionListener {
    override fun onReadyForSpeech(params: android.os.Bundle?) {}
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
    if (!state.isActive) return false
    val usable = chunks.filter { it.isNotBlank() }
    if (usable.isEmpty()) return false
    mainHandler.post { speakInternal(usable, voiceIdentifier, rate, pitch) }
    return true
  }

  private fun ensureTts(): TextToSpeech {
    tts?.let { return it }
    val created = TextToSpeech(this) { status ->
      mainHandler.post {
        ttsReady = status == TextToSpeech.SUCCESS
        if (!ttsReady) {
          if (speaking) {
            speaking = false
            stopBargeIn()
            emit("fatalError", mapOf("reason" to "speech-failed", "message" to "tts-init-$status"))
            end("speech-failed")
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
    if (generation != speechGeneration) return
    nextChunkIndex = index
    if (index >= queuedSpeech.size) {
      speaking = false
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
        if (!speaking) return@post
        speaking = false
        stopBargeIn()
        emit("fatalError", mapOf("reason" to "speech-failed", "message" to "tts-error"))
        end("speech-failed")
      }
    }

    override fun onDone(utteranceId: String?) {
      mainHandler.post {
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
    mainHandler.post {
      val pool = soundPool ?: run {
        val created = SoundPool.Builder()
          .setMaxStreams(1)
          .setAudioAttributes(
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
              .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
              .build(),
          )
          .build()
        soundPool = created
        created
      }
      if (earconId == 0) {
        earconId = pool.load(this, R.raw.handsfree_send_earcon, 1)
      }
      pool.setOnLoadCompleteListener { _, _, status ->
        if (status == 0) {
          // Fire-and-forget: a refused earcon is silent, never an event.
          try {
            pool.play(earconId, 1f, 1f, 1, 0, 1f)
          } catch (_: Exception) {
          }
        }
      }
    }
  }

  // ── Barge-in voice-activity detection ────────────────────────────────────

  private fun startBargeIn() {
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
    vadRunning = true
    noiseFloor = 0.0
    onsetMs = 0L
    lastLevelAt = 0L
    record.startRecording()
    val thread = Thread {
      val buffer = ShortArray(VAD_BLOCK_SAMPLES)
      while (vadRunning) {
        val read = try {
          record.read(buffer, 0, buffer.size)
        } catch (_: Exception) {
          -1
        }
        if (read <= 0) continue
        var sum = 0.0
        for (i in 0 until read) {
          val sample = buffer[i].toDouble()
          sum += sample * sample
        }
        val rms = sqrt(sum / read)
        val level = (rms / 32768.0).coerceIn(0.0, 1.0)
        val now = SystemClock.elapsedRealtime()
        if (noiseFloor == 0.0) {
          noiseFloor = level.coerceAtLeast(MIN_FLOOR)
        } else {
          noiseFloor = noiseFloor * (1 - FLOOR_ADAPT) + level * FLOOR_ADAPT
        }
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
    }
    thread.isDaemon = true
    vadThread = thread
    thread.start()
  }

  private fun handleBargeIn() {
    if (!speaking) return
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
    mainHandler.post {
      if (!state.setMuted(muted)) return@post
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
  }

  // ── Terminal transition ──────────────────────────────────────────────────

  fun end(reason: String) {
    mainHandler.post {
      if (!state.requestEnd(reason)) return@post
      teardown()
    }
  }

  private fun teardown() {
    if (destroyed) return
    destroyed = true
    listening = false
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
    // Distinct request codes: one PendingIntent per action, so the Mute intent
    // never overwrites the End intent's tap.
    private const val REQUEST_CODE_END = 8402
    private const val REQUEST_CODE_MUTE = 8403
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

    private const val TAG = "HandsfreeCallService"

    /** Set by the module just before it starts the service; answered exactly once. */
    @Volatile
    var pendingStartCallback: ((String) -> Unit)? = null

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
