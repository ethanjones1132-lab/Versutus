package com.versutus.handsfreevoice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.sqrt

/**
 * The phone's Gate media terminal: one WebSocket, one capture thread and one
 * playback thread for exactly the lifetime of a Gate-powered call. It runs no
 * speech model and holds no provider credential -- it is the microphone and
 * speaker for a call whose loop lives on the Gate.
 *
 * Incoming JSON frames are parsed by [GateFrameCodec] so generations can flush
 * stale audio, then forwarded to JS unchanged. Incoming binary frames are PCM
 * for the current generation and go through [JitterBuffer].
 */
class HandsfreeGateMedia(
  private val onFrame: (String) -> Unit,
  initiallyMuted: Boolean = false,
  private val resumeLastSeq: Long? = null,
) {
  companion object {
    const val CAPTURE_SAMPLE_RATE = 16000
    const val PLAYBACK_SAMPLE_RATE = 24000
    const val FRAME_MS = 20
    const val JITTER_TARGET_MS = 60
    private const val MAX_SOCKET_QUEUE_BYTES = CAPTURE_SAMPLE_RATE * 2 * 2

    private const val CAPTURE_CHANNELS = 1
    private const val CAPTURE_BYTES_PER_SAMPLE = 2
    private const val CAPTURE_FRAME_BYTES =
      CAPTURE_SAMPLE_RATE * CAPTURE_CHANNELS * CAPTURE_BYTES_PER_SAMPLE * FRAME_MS / 1000
    private const val MEDIA_FAILED_MESSAGE =
      "This phone could not open call audio capture or playback."
    /** A read that returns nothing is usually a dead device, not a quiet one. */
    private const val READ_FAILURE_BACKOFF_MS = 10L
    private const val MAX_CONSECUTIVE_READ_FAILURES = 100
    private const val MUTED_KEEPALIVE_MS = 15_000L
    private val phoneSequences = ConcurrentHashMap<String, AtomicLong>()
    private const val LOG_TAG = "HandsfreeGateMedia"
    /** The first few frames of each link are logged: enough to see a start. */
    private const val LOGGED_FRAMES = 3
  }

  /**
   * Gate frames this link has read since its last [start]. JS reads it to prove
   * the link without relying on the `gate` event: on the A54 that event lost a
   * live link's attach frames, and the start failed a call the PC was serving.
   * A terminal link reports -1, even if a frame arrived before it failed.
   */
  @Volatile var framesReceived = 0
    private set

  private val client = OkHttpClient.Builder()
    .readTimeout(0, TimeUnit.MILLISECONDS)
    // A half-open link (Wi-Fi -> cellular) never trips a read timeout, so
    // without a ping the phone only notices when the user speaks into nothing.
    // A missed pong arrives as onFailure, which the reconnect path already owns.
    .pingInterval(15, TimeUnit.SECONDS)
    .build()

  @Volatile private var running = false
  @Volatile private var stopped = false
  private val captureState = GateCaptureState()
  // The banner's dot has no level from the Gate: U5 is the phone's own
  // measurement of what its microphone captured, exactly as the phone engine
  // measures its barge-in tap. Display-only, so it is throttled below.
  private val captureLevel = GateCaptureLevelTap(
    emit = { level -> HandsfreeEventBridge.emit("level", mapOf("level" to level)) },
    nowMs = SystemClock::elapsedRealtime,
  )
  private val captureLock = Any()
  // Serializes control sequencing and the last check before a PCM enqueue.
  // Never held across a blocking AudioRecord read.
  private val sendLock = Any()
  @Volatile private var socketOpen = false
  @Volatile private var negotiationConfirmed = false
  @Volatile private var protocolV2 = false
  private var activeCallId = ""
  private var lastMuteFrameSent: Boolean? = null
  private var readyMuteSynced = false
  private val speechStartSequences = mutableMapOf<Long, Long>()

  init { captureState.setMuted(initiallyMuted) }
  @Volatile private var sawEnded = false
  @Volatile private var socket: WebSocket? = null
  private var captureThread: Thread? = null
  private var playbackThread: Thread? = null
  private var micSource: MicSource? = null
  private var audioTrack: AudioTrack? = null
  private var echoCanceler: AcousticEchoCanceler? = null
  private var noiseSuppressor: NoiseSuppressor? = null

  private val buffer = JitterBuffer(
    sampleRateHz = PLAYBACK_SAMPLE_RATE,
    targetMs = JITTER_TARGET_MS,
    maxPendingMs = 2_000,
    onCapacityReached = {
      Log.w("HandsfreeGateMedia", "Refusing speech audio after two-second queue limit")
      reportPressure("playback_backpressure")
    },
  )
  private val playbackLock = Any()
  @Volatile private var currentGen = 0L
  private val playedGens = mutableSetOf<Long>()
  private var firstPcmReceivedAtMs: Long? = null
  private var firstPcmReceivedGen: Long? = null

  @Synchronized fun start(url: String, token: String, voiceSessionId: String): Boolean {
    stop()
    stopped = false
    running = true
    negotiationConfirmed = false
    protocolV2 = false
    activeCallId = voiceSessionId
    framesReceived = 0
    captureState.setNegotiated(false)
    captureState.setPaused(false)
    captureState.setRunning(true)
    captureLevel.reset()
    sawEnded = false
    currentGen = 0L
    playedGens.clear()
    firstPcmReceivedAtMs = null
    firstPcmReceivedGen = null
    speechStartSequences.clear()
    buffer.flush()

    val streamUrl = buildStreamUrl(url, voiceSessionId)
    val request = Request.Builder()
      .url(streamUrl)
      // OkHttp throws on any control character in a header value, and a stored
      // token with a trailing \r turned every call start into "unavailable".
      .addHeader("Authorization", "Bearer ${cleanHeaderValue(token)}")
      .build()
    // A call with no microphone or no speaker is failed at once instead of
    // letting the Gate's opening frame prove a link that cannot carry audio.
    if (!runCatching { startCapture() && startPlayback() }.getOrDefault(false)) {
      reportMediaFailure()
      stop()
      return false
    }
    synchronized(sendLock) { socket = client.newWebSocket(request, listener) }
    return true
  }

  fun sendControl(json: String): Boolean {
    val control = try {
      GateFrameCodec.parsePhone(json, activeCallId)
    } catch (_: Exception) {
      null
    }
    if (control is GateFrame.Phone.Mute) return setMuted(control.on)
    return synchronized(sendLock) {
      if (negotiationConfirmed && socketOpen) sendControlLocked(json) else false
    }
  }

  /**
   * Mute or unmute the microphone and tell the Gate.
   *
   * Nothing here waits on [captureLock]: the capture loop holds it across a
   * blocking AudioRecord read, and a Mute tap queued behind that read is a
   * button that does nothing for a whole frame (and, on the caller's thread, a
   * banner that cannot redraw). The mute itself is the capture state's own
   * volatile flag, which the loop reads before and after every read; the socket
   * write is OkHttp's own queue, never the main thread.
   */
  fun setMuted(muted: Boolean): Boolean = synchronized(sendLock) {
    captureState.setMuted(muted)
    sendMuteIfOpen()
  }

  internal fun isMuted(): Boolean = captureState.isMuted()
  internal fun isRunning(): Boolean = running
  internal fun isStopped(): Boolean = stopped

  /** Caller holds sendLock. */
  private fun sendMuteIfOpen(force: Boolean = false): Boolean {
    val muted = captureState.isMuted()
    if (!socketOpen || !negotiationConfirmed) return false
    if (!force && lastMuteFrameSent == muted) return true
    val sent = sendControlLocked(GateFrameCodec.encodePhone(GateFrame.Phone.Mute(muted)))
    if (sent) lastMuteFrameSent = muted
    return sent
  }

  private fun sendControlLocked(json: String): Boolean =
    socket?.send(encodeNegotiatedControl(json)) ?: false

  @Synchronized fun stop() {
    if (stopped) return
    stopped = true
    running = false
    synchronized(captureLock) { captureState.setRunning(false) }
    HandsfreeGateMediaOwner.detach(this)
    synchronized(sendLock) {
      socket?.close(1000, "call ended")
      socket = null
      socketOpen = false
      lastMuteFrameSent = null
      readyMuteSynced = false
    }
    // Both loops end on `running`, so the interrupt is only a wake-up: they
    // restore its flag and return rather than dying with it.
    captureThread?.interrupt()
    captureThread = null
    playbackThread?.interrupt()
    playbackThread = null
    echoCanceler?.release()
    echoCanceler = null
    noiseSuppressor?.release()
    noiseSuppressor = null
    micSource?.runCatching { stop(); release() }
    micSource = null
    audioTrack?.runCatching {
      if (playState == AudioTrack.PLAYSTATE_PLAYING) stop()
      release()
    }
    audioTrack = null
    buffer.flush()
  }

  private val listener = object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      synchronized(sendLock) {
        if (webSocket !== socket) return
        socketOpen = true
      }
    }

    // Every callback is identity-guarded: a replaced or stopped socket's
    // late frames must not reach the call a new socket now serves.
    override fun onMessage(webSocket: WebSocket, text: String) {
      if (webSocket != socket) return
      handleTextFrame(text)
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      if (webSocket != socket) return
      val payload = bytes.toByteArray()
      synchronized(playbackLock) {
        if (protocolV2) {
          val chunk = parseGatePcmChunk(payload) ?: return
          val gen = chunk.gen
          if (speechStartSequences[gen] != chunk.startSeq) return
          if (firstPcmReceivedGen != gen) {
            firstPcmReceivedGen = gen
            firstPcmReceivedAtMs = SystemClock.elapsedRealtime()
          }
          buffer.push(gen, chunk.pcm)
          return
        }
        if (firstPcmReceivedGen != currentGen) {
          firstPcmReceivedGen = currentGen
          firstPcmReceivedAtMs = SystemClock.elapsedRealtime()
        }
      }
      buffer.push(currentGen, payload)
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      if (webSocket != socket) return
      webSocket.close(1000, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      if (!markSocketGone(webSocket)) return
      if (running && !sawEnded) {
        // The Gate also puts its reason in the close when it ends a call. In
        // particular, control backlog can prevent the ended frame from being
        // sent, even if the close itself makes it through.
        if (code == 1000 && reason in GATE_END_CLOSE_REASONS) {
          handleTextFrame("""{"t":"ended","reason":"${escapeJsonString(reason)}"}""")
          return
        }
        HandsfreeGateMediaOwner.reportLinkLost()
        onFrame(errorFrame("socket_closed", "The PC closed the call audio link."))
      }
    }

    override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
      if (!markSocketGone(webSocket) || !running || sawEnded) return
      // A running call keeps its notification up: the phone names the link it
      // is rebuilding rather than showing a phase from a socket that is gone.
      HandsfreeGateMediaOwner.reportLinkLost()
      onFrame(errorFrame("socket_failed", error.message ?: "socket failed"))
    }
  }

  private fun markSocketGone(webSocket: WebSocket): Boolean = synchronized(sendLock) {
    if (webSocket !== socket) return@synchronized false
    socketOpen = false
    framesReceived = -1
    captureState.setNegotiated(false)
    true
  }

  /**
   * The phone's only hand-built frames. OkHttp's messages carry quotes and
   * newlines, and JS only counts a `socket_failed` frame as retryable if it
   * parses, so every value goes through [escapeJsonString].
   */
  private fun errorFrame(code: String, message: String, fatal: Boolean = true): String =
    """{"t":"error","code":"${escapeJsonString(code)}","message":"${escapeJsonString(message)}","fatal":$fatal}"""

  private fun reportPressure(code: String) {
    // Local status only: this is emitted to the app, never put on the wire.
    onFrame(errorFrame(code, "", fatal = false))
    HandsfreeGateMediaOwner.reportAudioPressure(code)
  }

  private fun reportMediaFailure() {
    synchronized(sendLock) {
      running = false
      framesReceived = -1
      captureState.setNegotiated(false)
    }
    onFrame(errorFrame("media_failed", MEDIA_FAILED_MESSAGE))
  }

  private fun handleTextFrame(text: String) {
    val frame = try {
      GateFrameCodec.parse(text, activeCallId)
    } catch (error: GateProtocolError) {
      Log.w(LOG_TAG, "dropped an unreadable Gate frame: ${error.message}")
      return
    }
    val terminal = frame is GateFrame.Ended || (frame is GateFrame.Error && frame.fatal) ||
      (frame is GateFrame.Call && (frame.state == "ending" || frame.state == "ended"))
    val seen = synchronized(sendLock) {
      if (terminal) {
        framesReceived = -1
        sawEnded = true
        running = false
        captureState.setNegotiated(false)
      } else if (framesReceived >= 0) {
        framesReceived += 1
      }
      val ready = frame is GateFrame.Ready || (frame is GateFrame.Phase && frame.phase != "opening")
      if (!terminal && running && socketOpen) {
        if (frame.protocolVersion == 2) protocolV2 = true
        if (!negotiationConfirmed && (protocolV2 || frame is GateFrame.Ready || frame is GateFrame.Phase)) {
          negotiationConfirmed = true
          // Resume must be the first v2 control. Queue mute immediately after
          // it, in wire order, before any other controls or microphone PCM.
          val sent = sendGateAttachControls(
            protocolV2, resumeLastSeq,
            resume = { lastSeq -> sendControlLocked(GateFrameCodec.encodePhone(GateFrame.Phone.Resume(lastSeq))) },
            syncMute = { sendMuteIfOpen() },
          )
          readyMuteSynced = ready && sent
          captureState.setNegotiated(sent)
        } else if (negotiationConfirmed && ready && !readyMuteSynced) {
          // Older Gates ignore mute while opening their engine. Reassert the
          // current value at the first ready phase, not the one we opened with.
          readyMuteSynced = sendMuteIfOpen(force = true)
        }
      }
      framesReceived
    }
    if (seen in 1..LOGGED_FRAMES) {
      Log.i(LOG_TAG, "Gate frame $seen: t=${frame.t} v=${frame.protocolVersion}")
    }
    // The call's notification follows the Gate's own phases. The service does
    // not own this socket, so it hears what was parsed rather than reading it.
    // A parsed frame also shows the notification the socket is talking again.
    HandsfreeGateMediaOwner.reportFrame(frame)
    onFrame(text)
    when (frame) {
      is GateFrame.Speech -> {
        when (frame.state) {
          "start" -> synchronized(playbackLock) {
            currentGen = frame.gen
            if (frame.sequence != null) speechStartSequences[frame.gen] = frame.sequence!!
            buffer.start(frame.gen)
          }
          "cancelled" -> {
            // AudioTrack may already contain samples beyond the queue. Pause
            // before flushing so no written tail remains audible after cancel.
            synchronized(playbackLock) {
              currentGen = frame.gen
              buffer.cancel(frame.gen)
              audioTrack?.runCatching {
                pause()
                flush()
                if (running) play()
              }
            }
          }
        }
      }
      is GateFrame.Ended -> {
        phoneSequences.remove(activeCallId)
      }
      else -> Unit
    }
  }

  private fun startCapture(): Boolean {
    val minBytes = AudioRecord.getMinBufferSize(
      CAPTURE_SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    val bufferBytes = maxOf(minBytes, CAPTURE_FRAME_BYTES * 2)
    val record = try {
      AudioRecord(
        MediaRecorder.AudioSource.VOICE_COMMUNICATION,
        CAPTURE_SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        bufferBytes,
      )
    } catch (_: Exception) {
      null
    } ?: return false
    if (record.state != AudioRecord.STATE_INITIALIZED) {
      record.release()
      return false
    }
    val source = AudioRecordMicSource(record)
    micSource = source
    if (AcousticEchoCanceler.isAvailable()) {
      echoCanceler = AcousticEchoCanceler.create(record.audioSessionId)?.also { it.enabled = true }
    }
    if (NoiseSuppressor.isAvailable()) {
      noiseSuppressor = NoiseSuppressor.create(record.audioSessionId)?.also { it.enabled = true }
    }
    captureState.attachSource(source)
    captureThread = Thread {
      val frame = ByteArray(CAPTURE_FRAME_BYTES)
      val pressure = GateCapturePressure(MAX_SOCKET_QUEUE_BYTES, CAPTURE_FRAME_BYTES) { paused ->
        captureState.setPaused(paused)
        reportPressure(if (paused) "capture_backpressure" else "capture_backpressure_cleared")
      }
      var failedReads = 0
      var nextMuteRefreshAt = SystemClock.elapsedRealtime() + MUTED_KEEPALIVE_MS
      try {
        while (running) {
          val current = socket
          if (socketOpen && captureState.isMuted()) {
            val now = SystemClock.elapsedRealtime()
            if (now >= nextMuteRefreshAt) {
              // Older Gates don't renew the silent call's lease on ping. The
              // existing idempotent mute control still works as a keepalive.
              synchronized(sendLock) {
                if (captureState.isMuted()) sendMuteIfOpen(force = true) else false
              }
              nextMuteRefreshAt = now + MUTED_KEEPALIVE_MS
            }
          }
          if (current == null || !socketOpen || pressure.shouldPause(current.queueSize()) || !captureState.shouldRead()) {
            failedReads = 0
            Thread.sleep(READ_FAILURE_BACKOFF_MS)
            continue
          }
          var sent = false
          val read = synchronized(captureLock) {
            captureState.readAndSend(source, frame) { bytes ->
              sent = synchronized(sendLock) {
                // A closing socket may decline a send; the close/failure
                // callback (or a missed pong) owns reconnect, not capture.
                running && socketOpen && current === socket && captureState.shouldSend() &&
                  !pressure.shouldPause(current.queueSize()) && current.send(ByteString.of(*bytes))
              }
            }
          }
          if (!captureState.shouldRead()) {
            failedReads = 0
            continue
          }
          if (read <= 0) {
            // A record whose mic was taken by another app, or that lost audio
            // focus, fails every read at once: spinning on it burns the CPU for
            // the rest of the call and sends the Gate silence.
            Thread.sleep(READ_FAILURE_BACKOFF_MS)
            failedReads += 1
            if (failedReads >= MAX_CONSECUTIVE_READ_FAILURES) {
              reportMediaFailure()
              break
            }
            continue
          }
          // Measured from the frame just read, so the meter follows the audio
          // the Gate is actually receiving rather than a timer or a stub.
          if (sent) captureLevel.accept(frame, read)
          failedReads = 0
        }
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      } catch (_: Throwable) {
        // The default handler would kill the app on a capture thread.
      }
    }.also { it.name = "gate-capture"; it.start() }
    return true
  }

  private fun startPlayback(): Boolean {
    val minBytes = AudioTrack.getMinBufferSize(
      PLAYBACK_SAMPLE_RATE,
      AudioFormat.CHANNEL_OUT_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    val track = try {
      AudioTrack.Builder()
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        )
        .setAudioFormat(
          AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(PLAYBACK_SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build(),
        )
        .setBufferSizeInBytes(maxOf(minBytes, JITTER_TARGET_MS * 48 * 4))
        .setTransferMode(AudioTrack.MODE_STREAM)
        .build()
    } catch (_: Exception) {
      null
    } ?: return false
    if (track.state != AudioTrack.STATE_INITIALIZED) {
      track.release()
      return false
    }
    audioTrack = track
    track.play()
    playbackThread = Thread {
      PlaybackLoop(
        isRunning = { running },
        drain = { buffer.drain() },
        write = { chunk ->
          // Revalidate after dequeue under the same lock as cancel's flush: a
          // chunk removed just before cancel must not be written after it.
          val written = synchronized(playbackLock) {
            if (buffer.isCurrent(chunk.gen)) track.write(chunk.pcm, 0, chunk.pcm.size) else 0
          }
          val gen = chunk.gen
          if (written > 0) {
            val firstForGen = synchronized(playedGens) { playedGens.add(gen) }
            if (firstForGen) {
              // `atMs` is a duration from receipt of this generation's first PCM,
              // not a phone wall-clock timestamp: the Gate can safely add it to
              // its own commit-to-send interval regardless of device clock skew.
              val receivedAtMs = synchronized(playbackLock) {
                if (firstPcmReceivedGen == gen) firstPcmReceivedAtMs else null
              }
              if (receivedAtMs != null) {
                val elapsedMs = elapsedSincePcmReceived(receivedAtMs, SystemClock.elapsedRealtime())
                sendControl(GateFrameCodec.encodePhone(GateFrame.Phone.Played(gen, elapsedMs)))
              }
            }
          }
        },
      ).run()
    }.also { it.name = "gate-playback"; it.start() }
    return true
  }

  private fun buildStreamUrl(url: String, voiceSessionId: String): String {
    val normalized = url
      .replaceFirst("^ws://", "http://")
      .replaceFirst("^wss://", "https://")
    val separator = if (normalized.contains('?')) '&' else '?'
    return "$normalized${separator}voiceSessionId=$voiceSessionId"
  }

  private fun encodeNegotiatedControl(json: String): String {
    if (!protocolV2) return json
    val frame = JSONObject(json)
      .put("v", 2)
      .put("callId", activeCallId)
      .put("seq", phoneSequences.computeIfAbsent(activeCallId) { AtomicLong() }.incrementAndGet())
      .put("ts", SystemClock.elapsedRealtime())
    return frame.toString()
  }
}

private val GATE_END_CLOSE_REASONS = setOf(
  "user", "gate-restart", "network", "abandoned", "engine", "engine-error", "backpressure",
)

/** OkHttp cannot evict queued sends. Pause capture until the existing queue drains. */
internal class GateCapturePressure(
  private val maxBytes: Int,
  private val frameBytes: Int,
  private val onChanged: (Boolean) -> Unit,
) {
  private var paused = false

  fun shouldPause(queuedBytes: Long): Boolean {
    val next = if (paused) queuedBytes > maxBytes / 2 else queuedBytes + frameBytes > maxBytes
    if (next != paused) {
      paused = next
      onChanged(next)
    }
    return paused
  }
}

/** The same mute frame works with a v1 attach and an in-order v2 resume. */
internal fun sendGateAttachControls(
  protocolV2: Boolean,
  lastSeq: Long?,
  resume: (Long) -> Boolean,
  syncMute: () -> Boolean,
): Boolean = (!protocolV2 || lastSeq == null || resume(lastSeq)) && syncMute()

internal data class GatePcmChunk(val gen: Long, val startSeq: Long, val pcm: ByteArray)

/** V2 carries generation and the sequence of its `speech/start` control first. */
internal fun parseGatePcmChunk(bytes: ByteArray): GatePcmChunk? {
  if (bytes.size < 8) return null
  val header = java.nio.ByteBuffer.wrap(bytes, 0, 8).order(java.nio.ByteOrder.BIG_ENDIAN)
  val gen = header.int.toLong() and 0xffffffffL
  val startSeq = header.int.toLong() and 0xffffffffL
  return GatePcmChunk(gen, startSeq, bytes.copyOfRange(8, bytes.size))
}

/** A monotonic duration for `played.atMs`; wall-clock time is not comparable to Gate time. */
internal fun elapsedSincePcmReceived(receivedAtMs: Long, playedAtMs: Long): Long =
  (playedAtMs - receivedAtMs).coerceAtLeast(0L)

/** Pure gate around AudioRecord reads, so mute behavior is JVM-testable. */
internal class GateCaptureState {
  @Volatile private var muted = false
  @Volatile private var running = false
  @Volatile private var negotiated = true
  @Volatile private var paused = false
  private var source: MicSource? = null

  @Synchronized fun setMuted(value: Boolean): Boolean {
    if (muted == value) return false
    muted = value
    updateSource()
    return true
  }
  fun isMuted(): Boolean = muted
  @Synchronized fun attachSource(value: MicSource) { source = value; updateSource() }
  @Synchronized fun setRunning(value: Boolean) { running = value; updateSource() }
  @Synchronized fun setNegotiated(value: Boolean) {
    if (negotiated == value) return
    negotiated = value
    updateSource()
  }
  @Synchronized fun setPaused(value: Boolean) {
    if (paused == value) return
    paused = value
    updateSource()
  }
  // Deliberately NOT @Synchronized: the capture loop spends this call's whole
  // duration inside the blocking read below, and a Mute tap must not wait for
  // it. Every field it reads is @Volatile, and the source is passed in.
  fun readAndSend(mic: MicSource, buffer: ByteArray, send: (ByteArray) -> Unit): Int {
    if (!shouldRead()) return 0
    val count = mic.read(buffer, 0, buffer.size)
    if (count > 0 && shouldSend()) send(buffer.copyOf(count))
    return count
  }
  // Stopping a recorder is not proof its buffer is empty, and restarting it is
  // not proof the buffer was flushed: drain after both, so no sample captured
  // while muted can ever be read (a restart gives up a few ms of fresh audio).
  private fun updateSource() {
    val current = source ?: return
    runCatching {
      if (shouldRead()) {
        current.start()
        current.drain()
      } else {
        current.stop()
        current.drain()
      }
    }
  }
  fun shouldRead(): Boolean = running && negotiated && !muted && !paused
  fun shouldSend(): Boolean = shouldRead()
}

/** The banner's dot is display-only, so ten samples a second is plenty. */
private const val CAPTURE_LEVEL_INTERVAL_MS = 100L

/**
 * Turns one captured PCM frame into the 0-1 level the banner's dot animates
 * from. The phone engine samples its own tap; a Gate call has no tap, so the
 * same measurement is taken from what this capture loop actually read and sent.
 *
 * It is display-only: the sample is dropped unless a whole interval has passed,
 * because the banner must not be asked to redraw it per 20 ms of audio, and
 * `level` is the protocol's first frame to drop under load.
 */
internal class GateCaptureLevelTap(
  private val emit: (Double) -> Unit,
  private val nowMs: () -> Long,
  private val intervalMs: Long = CAPTURE_LEVEL_INTERVAL_MS,
) {
  private var lastAtMs: Long? = null

  /** A new call reports its first frame at once, not after the last call's tick. */
  fun reset() {
    lastAtMs = null
  }

  fun accept(pcm: ByteArray, count: Int) {
    if (count <= 0) return
    val now = nowMs()
    val previous = lastAtMs
    if (previous != null && now - previous < intervalMs) return
    lastAtMs = now
    emit(GateCaptureLevel.rmsLevel(pcm, count))
  }
}

/** The RMS math, kept out of the capture loop so it is proved on the JVM. */
internal object GateCaptureLevel {
  private const val SAMPLE_SCALE = 32768.0

  fun rmsLevel(pcm: ByteArray, count: Int): Double {
    // PCM16 is two bytes a sample; a trailing odd byte has no sample of its own.
    val limit = minOf(count, pcm.size) / 2 * 2
    if (limit <= 0) return 0.0
    var sum = 0.0
    var index = 0
    while (index < limit) {
      // Little-endian: the high byte is signed, so its shift carries the sign.
      val sample = (pcm[index + 1].toInt() shl 8) or (pcm[index].toInt() and 0xFF)
      sum += sample.toDouble() * sample
      index += 2
    }
    val rms = sqrt(sum / (limit / 2))
    return (rms / SAMPLE_SCALE).coerceIn(0.0, 1.0)
  }
}

/**
 * What the call service hears from the Gate media link it does not own: the
 * frames parsed on the live socket (so the notification can name the Gate's own
 * phase) and the socket dying under a running call (so it can say the link is
 * being rebuilt).
 */
internal interface HandsfreeGateMediaListener {
  /** A Gate frame was parsed on the live socket. */
  fun onGateFrame(frame: GateFrame)

  /** The socket failed or closed while the call was still running. */
  fun onGateLinkLost()

  fun onGateAudioPressure(code: String) {}
}

/** The service and module have separate lifetimes; this bridges their media instance. */
internal object HandsfreeGateMediaOwner {
  private var media: HandsfreeGateMedia? = null
  private var closed = false
  private var muted = false
  // Read on the socket's own thread when a frame lands; written on the main
  // thread when a call starts or ends.
  @Volatile private var listener: HandsfreeGateMediaListener? = null

  @Synchronized fun beginCall() { closed = false; muted = false }
  @Synchronized fun attach(value: HandsfreeGateMedia) {
    if (closed) { value.stop(); return }
    media = value
    value.setMuted(muted)
  }
  @Synchronized fun detach(value: HandsfreeGateMedia) { if (media === value) media = null }
  @Synchronized fun setMuted(value: Boolean) { muted = value; media?.setMuted(value) }
  @Synchronized fun isMuted(): Boolean = muted

  /**
   * Where the call's phase words and link losses are reported. Held by the
   * service for exactly the call's life, across media instances: a reconnect
   * replaces the socket but not the call whose notification follows it.
   */
  @Synchronized fun watch(listener: HandsfreeGateMediaListener?) { this.listener = listener }

  /** A parsed Gate frame on the live socket, whichever media instance read it. */
  fun reportFrame(frame: GateFrame) {
    listener?.onGateFrame(frame)
  }

  /** The media socket failed or closed under a call that is still running. */
  fun reportLinkLost() {
    listener?.onGateLinkLost()
  }

  fun reportAudioPressure(code: String) {
    listener?.onGateAudioPressure(code)
  }

  @Synchronized fun stop() {
    closed = true
    listener = null
    val current = media
    media = null
    current?.stop()
  }
}

internal interface MicSource {
  fun start()
  fun stop()
  fun read(buffer: ByteArray, offset: Int, length: Int): Int
  /** Discards whatever the source has buffered, without blocking. */
  fun drain()
  fun release()
}

private class AudioRecordMicSource(private val record: AudioRecord) : MicSource {
  override fun start() { if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) record.startRecording() }
  override fun stop() { if (record.recordingState == AudioRecord.RECORDSTATE_RECORDING) record.stop() }
  override fun read(buffer: ByteArray, offset: Int, length: Int): Int = record.read(buffer, offset, length)
  override fun drain() {
    val scratch = ByteArray(4096)
    // Bounded: a live recorder refills while we read, and this must not spin.
    repeat(64) {
      if (record.read(scratch, 0, scratch.size, AudioRecord.READ_NON_BLOCKING) <= 0) return
    }
  }
  override fun release() { record.release() }
}
