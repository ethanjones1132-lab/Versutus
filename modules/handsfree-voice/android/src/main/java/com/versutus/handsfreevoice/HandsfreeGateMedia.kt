package com.versutus.handsfreevoice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
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
class HandsfreeGateMedia(private val onFrame: (String) -> Unit) {
  companion object {
    const val CAPTURE_SAMPLE_RATE = 16000
    const val PLAYBACK_SAMPLE_RATE = 24000
    const val FRAME_MS = 20
    const val JITTER_TARGET_MS = 60

    private const val CAPTURE_CHANNELS = 1
    private const val CAPTURE_BYTES_PER_SAMPLE = 2
    private const val CAPTURE_FRAME_BYTES =
      CAPTURE_SAMPLE_RATE * CAPTURE_CHANNELS * CAPTURE_BYTES_PER_SAMPLE * FRAME_MS / 1000
  }

  private val client = OkHttpClient.Builder()
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .build()

  @Volatile private var running = false
  private var socket: WebSocket? = null
  private var captureThread: Thread? = null
  private var playbackThread: Thread? = null
  private var audioRecord: AudioRecord? = null
  private var audioTrack: AudioTrack? = null
  private var echoCanceler: AcousticEchoCanceler? = null
  private var noiseSuppressor: NoiseSuppressor? = null

  private val buffer = JitterBuffer(
    sampleRateHz = PLAYBACK_SAMPLE_RATE,
    targetMs = JITTER_TARGET_MS,
  )
  @Volatile private var currentGen = 0L

  fun start(context: Context, url: String, token: String, voiceSessionId: String) {
    stop()
    running = true
    currentGen = 0L
    buffer.flush()

    val streamUrl = buildStreamUrl(url, voiceSessionId)
    val request = Request.Builder()
      .url(streamUrl)
      // OkHttp throws on any control character in a header value, and a stored
      // token with a trailing \r turned every call start into "unavailable".
      .addHeader("Authorization", "Bearer ${cleanHeaderValue(token)}")
      .build()
    socket = client.newWebSocket(request, listener)
    startCapture(context)
    startPlayback()
  }

  fun sendControl(json: String): Boolean = socket?.send(json) ?: false

  fun stop() {
    running = false
    socket?.close(1000, "call ended")
    socket = null
    captureThread?.interrupt()
    captureThread = null
    playbackThread?.interrupt()
    playbackThread = null
    echoCanceler?.release()
    echoCanceler = null
    noiseSuppressor?.release()
    noiseSuppressor = null
    audioRecord?.runCatching {
      if (recordingState == AudioRecord.RECORDSTATE_RECORDING) stop()
      release()
    }
    audioRecord = null
    audioTrack?.runCatching {
      if (playState == AudioTrack.PLAYSTATE_PLAYING) stop()
      release()
    }
    audioTrack = null
    buffer.flush()
  }

  private val listener = object : WebSocketListener() {
    override fun onMessage(webSocket: WebSocket, text: String) {
      handleTextFrame(text)
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      buffer.push(currentGen, bytes.toByteArray())
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(1000, null)
    }

    override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
      onFrame("""{"t":"error","code":"socket_failed","message":"${error.message ?: "socket failed"}","fatal":true}""")
    }
  }

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
        if (frame.state == "cancelled") buffer.cancel(frame.gen)
      }
      is GateFrame.Ended -> running = false
      else -> Unit
    }
  }

  private fun startCapture(context: Context) {
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
    } ?: return
    if (record.state != AudioRecord.STATE_INITIALIZED) {
      record.release()
      return
    }
    audioRecord = record
    if (AcousticEchoCanceler.isAvailable()) {
      echoCanceler = AcousticEchoCanceler.create(record.audioSessionId)?.also { it.enabled = true }
    }
    if (NoiseSuppressor.isAvailable()) {
      noiseSuppressor = NoiseSuppressor.create(record.audioSessionId)?.also { it.enabled = true }
    }
    record.startRecording()
    captureThread = Thread {
      val frame = ByteArray(CAPTURE_FRAME_BYTES)
      while (running) {
        val read = record.read(frame, 0, frame.size)
        if (read <= 0) continue
        socket?.send(ByteString.of(*frame.copyOf(read)))
      }
    }.also { it.name = "gate-capture"; it.start() }
  }

  private fun startPlayback() {
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
    } ?: return
    if (track.state != AudioTrack.STATE_INITIALIZED) {
      track.release()
      return
    }
    audioTrack = track
    track.play()
    playbackThread = Thread {
      while (running) {
        val pcm = buffer.drain()
        if (pcm == null) {
          Thread.sleep(5)
          continue
        }
        track.write(pcm, 0, pcm.size)
      }
    }.also { it.name = "gate-playback"; it.start() }
  }

  private fun buildStreamUrl(url: String, voiceSessionId: String): String {
    val normalized = url
      .replaceFirst("^ws://", "http://")
      .replaceFirst("^wss://", "https://")
    val separator = if (normalized.contains('?')) '&' else '?'
    return "$normalized${separator}voiceSessionId=$voiceSessionId"
  }
}
