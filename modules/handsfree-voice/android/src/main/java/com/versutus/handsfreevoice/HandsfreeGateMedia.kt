package com.versutus.handsfreevoice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.util.Log
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.TimeUnit

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
) {
  companion object {
    const val CAPTURE_SAMPLE_RATE = 16000
    const val PLAYBACK_SAMPLE_RATE = 24000
    const val FRAME_MS = 20
    const val JITTER_TARGET_MS = 60

    private const val CAPTURE_CHANNELS = 1
    private const val CAPTURE_BYTES_PER_SAMPLE = 2
    private const val CAPTURE_FRAME_BYTES =
      CAPTURE_SAMPLE_RATE * CAPTURE_CHANNELS * CAPTURE_BYTES_PER_SAMPLE * FRAME_MS / 1000
    private const val MEDIA_FAILED_MESSAGE =
      "This phone could not open call audio capture or playback."
    /** A read that returns nothing is usually a dead device, not a quiet one. */
    private const val READ_FAILURE_BACKOFF_MS = 10L
    private const val MAX_CONSECUTIVE_READ_FAILURES = 100
  }

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
  private val captureLock = Any()
  @Volatile private var socketOpen = false
  private var lastMuteFrameSent: Boolean? = null

  init { captureState.setMuted(initiallyMuted) }
  @Volatile private var sawEnded = false
  private var socket: WebSocket? = null
  private var captureThread: Thread? = null
  private var playbackThread: Thread? = null
  private var micSource: MicSource? = null
  private var audioTrack: AudioTrack? = null
  private var echoCanceler: AcousticEchoCanceler? = null
  private var noiseSuppressor: NoiseSuppressor? = null

  private val buffer = JitterBuffer(
    sampleRateHz = PLAYBACK_SAMPLE_RATE,
    targetMs = JITTER_TARGET_MS,
    onCapacityReached = { Log.w("HandsfreeGateMedia", "Refusing speech audio after 60 s queue limit") },
  )
  private val playbackLock = Any()
  @Volatile private var currentGen = 0L
  private val playedGens = mutableSetOf<Long>()

  @Synchronized fun start(context: Context, url: String, token: String, voiceSessionId: String) {
    stop()
    stopped = false
    running = true
    captureState.setRunning(true)
    sawEnded = false
    currentGen = 0L
    playedGens.clear()
    buffer.flush()

    val streamUrl = buildStreamUrl(url, voiceSessionId)
    val request = Request.Builder()
      .url(streamUrl)
      // OkHttp throws on any control character in a header value, and a stored
      // token with a trailing \r turned every call start into "unavailable".
      .addHeader("Authorization", "Bearer ${cleanHeaderValue(token)}")
      .build()
    socket = client.newWebSocket(request, listener)
    // A call with no microphone or no speaker is failed at once instead of
    // idling until the Gate's no-audio timeout closes the socket silently.
    if (!startCapture(context) || !startPlayback()) {
      onFrame(errorFrame("media_failed", MEDIA_FAILED_MESSAGE))
      stop()
    }
  }

  fun sendControl(json: String): Boolean {
    val control = try {
      GateFrameCodec.parsePhone(json)
    } catch (_: Exception) {
      null
    }
    if (control is GateFrame.Phone.Mute) return setMuted(control.on)
    return socket?.send(json) ?: false
  }

  fun setMuted(muted: Boolean): Boolean {
    synchronized(captureLock) {
      captureState.setMuted(muted)
    }
    return sendMuteIfOpen(muted)
  }

  internal fun isMuted(): Boolean = captureState.isMuted()
  internal fun isRunning(): Boolean = running
  internal fun isStopped(): Boolean = stopped

  private fun sendMuteIfOpen(muted: Boolean): Boolean = synchronized(captureLock) {
    if (!socketOpen) return@synchronized false
    if (lastMuteFrameSent == muted) return@synchronized true
    val sent = socket?.send(GateFrameCodec.encodePhone(GateFrame.Phone.Mute(muted))) ?: false
    if (sent) lastMuteFrameSent = muted
    sent
  }

  @Synchronized fun stop() {
    if (stopped) return
    stopped = true
    running = false
    synchronized(captureLock) { captureState.setRunning(false) }
    HandsfreeGateMediaOwner.detach(this)
    socket?.close(1000, "call ended")
    socket = null
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
    socketOpen = false
    lastMuteFrameSent = null
    audioTrack?.runCatching {
      if (playState == AudioTrack.PLAYSTATE_PLAYING) stop()
      release()
    }
    audioTrack = null
    buffer.flush()
  }

  private val listener = object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      if (webSocket !== socket) return
      socketOpen = true
      sendMuteIfOpen(captureState.isMuted())
    }

    // Every callback is identity-guarded: a replaced or stopped socket's
    // late frames must not reach the call a new socket now serves.
    override fun onMessage(webSocket: WebSocket, text: String) {
      if (webSocket != socket) return
      handleTextFrame(text)
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      if (webSocket != socket) return
      buffer.push(currentGen, bytes.toByteArray())
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      if (webSocket != socket) return
      webSocket.close(1000, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      if (webSocket != socket) return
      // A clean close the Gate did not announce with an ended frame is still
      // the end of the call from the phone's side: its idle timeout and its
      // restart both close this way. Without a frame the banner would sit on
      // a dead call forever.
      if (running && !sawEnded) {
        onFrame(errorFrame("socket_closed", "The PC closed the call audio link."))
      }
    }

    override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
      if (webSocket != socket) return
      onFrame(errorFrame("socket_failed", error.message ?: "socket failed"))
    }
  }

  /**
   * The phone's only hand-built frames. OkHttp's messages carry quotes and
   * newlines, and JS only counts a `socket_failed` frame as retryable if it
   * parses, so every value goes through [escapeJsonString].
   */
  private fun errorFrame(code: String, message: String): String =
    """{"t":"error","code":"${escapeJsonString(code)}","message":"${escapeJsonString(message)}","fatal":true}"""

  private fun handleTextFrame(text: String) {
    onFrame(text)
    val frame = try {
      GateFrameCodec.parse(text)
    } catch (_: GateProtocolError) {
      return
    }
    when (frame) {
      is GateFrame.Speech -> {
        currentGen = frame.gen
        when (frame.state) {
          "start" -> buffer.start(frame.gen)
          "cancelled" -> {
            buffer.cancel(frame.gen)
            // AudioTrack may already contain samples beyond the queue. Pause
            // before flushing so no written tail remains audible after cancel.
            synchronized(playbackLock) {
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
        sawEnded = true
        running = false
      }
      else -> Unit
    }
  }

  private fun startCapture(context: Context): Boolean {
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
      var failedReads = 0
      try {
        while (running) {
          if (!captureState.shouldRead()) {
            Thread.sleep(READ_FAILURE_BACKOFF_MS)
            continue
          }
          val read = synchronized(captureLock) {
            captureState.readAndSend(source, frame) { bytes ->
              socket?.send(ByteString.of(*bytes))
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
              onFrame(errorFrame("media_failed", MEDIA_FAILED_MESSAGE))
              break
            }
            continue
          }
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
        write = { pcm ->
          // W5 serialises writes with cancel; W3 reports the first audible sample of each generation.
          val written = synchronized(playbackLock) { track.write(pcm, 0, pcm.size) }
          val gen = currentGen
          if (written > 0) {
            val firstForGen = synchronized(playedGens) { playedGens.add(gen) }
            if (firstForGen) {
              socket?.send(GateFrameCodec.encodePhone(GateFrame.Phone.Played(gen, System.currentTimeMillis())))
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
}

/** Pure gate around AudioRecord reads, so mute behavior is JVM-testable. */
internal class GateCaptureState {
  @Volatile private var muted = false
  @Volatile private var running = false
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
  @Synchronized fun readAndSend(mic: MicSource, buffer: ByteArray, send: (ByteArray) -> Unit): Int {
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
      if (running && !muted) {
        current.start()
        current.drain()
      } else {
        current.stop()
        current.drain()
      }
    }
  }
  fun shouldRead(): Boolean = running && !muted
  fun shouldSend(): Boolean = running && !muted
}

/** The service and module have separate lifetimes; this bridges their media instance. */
internal object HandsfreeGateMediaOwner {
  private var media: HandsfreeGateMedia? = null
  private var closed = false
  private var muted = false

  @Synchronized fun beginCall() { closed = false; muted = false }
  @Synchronized fun attach(value: HandsfreeGateMedia) {
    if (closed) { value.stop(); return }
    media = value
    value.setMuted(muted)
  }
  @Synchronized fun detach(value: HandsfreeGateMedia) { if (media === value) media = null }
  @Synchronized fun setMuted(value: Boolean) { muted = value; media?.setMuted(value) }
  @Synchronized fun isMuted(): Boolean = muted
  @Synchronized fun stop() {
    closed = true
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
