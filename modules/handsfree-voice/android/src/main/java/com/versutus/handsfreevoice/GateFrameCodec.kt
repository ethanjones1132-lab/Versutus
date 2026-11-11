package com.versutus.handsfreevoice

import org.json.JSONException
import org.json.JSONObject

const val MAX_FRAME_BYTES = 4096

/** A parsed Gate → phone media frame, the Kotlin mirror of `parseGateFrame`. */
sealed class GateFrame {
  abstract val t: String
  var protocolVersion: Int = 1

  data class Ready(val engine: String, val resumeWindowMs: Long?) : GateFrame() {
    override val t get() = "ready"
  }

  data class Phase(val phase: String) : GateFrame() {
    override val t get() = "phase"
  }

  data class Partial(val text: String) : GateFrame() {
    override val t get() = "partial"
  }

  data class Final(val turnId: String, val text: String) : GateFrame() {
    override val t get() = "final"
  }

  data class Turn(val turnId: String, val state: String, val error: String?) : GateFrame() {
    override val t get() = "turn"
  }

  data class Reply(val turnId: String, val delta: String) : GateFrame() {
    override val t get() = "reply"
  }

  data class Speech(val gen: Long, val state: String) : GateFrame() {
    override val t get() = "speech"
  }

  data class Level(val v: Double) : GateFrame() {
    override val t get() = "level"
  }

  data class Approval(val turnId: String, val summary: String) : GateFrame() {
    override val t get() = "approval"
  }

  data class Error(val code: String, val message: String, val fatal: Boolean) : GateFrame() {
    override val t get() = "error"
  }

  data class Ended(val reason: String) : GateFrame() {
    override val t get() = "ended"
  }

  data class Call(val state: String) : GateFrame() {
    override val t get() = "call"
  }

  /** A phone → Gate control frame. */
  sealed class Phone {
    abstract val t: String

    data class Mute(val on: Boolean) : Phone() {
      override val t get() = "mute"
    }

    object Skip : Phone() {
      override val t get() = "skip"
    }

    object BargeIn : Phone() {
      override val t get() = "bargein"
    }

    object End : Phone() {
      override val t get() = "end"
    }

    data class Played(val gen: Long, val atMs: Long) : Phone() {
      override val t get() = "played"
    }
  }
}

class GateProtocolError(message: String) : Exception(message)

/**
 * Parses the JSON text frames of the phone ↔ Gate media protocol exactly as
 * `gate/core/voice/protocol.mjs` and `src/lib/voice/voice-stream-protocol.ts`
 * do. Anything malformed, unknown or over [MAX_FRAME_BYTES] is refused rather
 * than guessed at.
 */
object GateFrameCodec {
  private val GATE_TYPES = setOf(
    "call", "ready", "phase", "partial", "final", "turn", "reply", "speech", "level", "approval", "error", "ended",
  )
  private val PHONE_TYPES = setOf("mute", "skip", "bargein", "end", "played")
  private val PHASES = setOf("opening", "listening", "thinking", "speaking", "muted")
  private val TURN_STATES = setOf("sent", "replying", "done", "failed")
  private val SPEECH_STATES = setOf("start", "end", "cancelled", "gap")

  fun parse(json: String, expectedCallId: String? = null): GateFrame {
    val frame = record(json, GATE_TYPES)
    if (frame.getString("t") == "call" && frame.opt("v") != 2) {
      throw GateProtocolError("call frames require protocol version 2")
    }
    val version = validateEnvelope(frame, expectedCallId)
    return fromGateRecord(frame).also { it.protocolVersion = version }
  }

  fun parsePhone(json: String, expectedCallId: String? = null): GateFrame.Phone {
    val frame = record(json, PHONE_TYPES)
    validateEnvelope(frame, expectedCallId)
    return when (frame.getString("t")) {
      "mute" -> {
        val on = frame.opt("on")
        if (on !is Boolean) throw GateProtocolError("on must be a boolean")
        GateFrame.Phone.Mute(on)
      }
      "skip" -> GateFrame.Phone.Skip
      "bargein" -> GateFrame.Phone.BargeIn
      "played" -> GateFrame.Phone.Played(
        requireNumber(frame, "gen").toLong(),
        requireNumber(frame, "atMs").toLong(),
      )
      else -> GateFrame.Phone.End
    }
  }

  fun encodePhone(frame: GateFrame.Phone): String = when (frame) {
    is GateFrame.Phone.Mute -> JSONObject().put("t", frame.t).put("on", frame.on).toString()
    is GateFrame.Phone.Played -> JSONObject().put("t", frame.t).put("gen", frame.gen).put("atMs", frame.atMs).toString()
    else -> JSONObject().put("t", frame.t).toString()
  }

  private fun fromGateRecord(frame: JSONObject): GateFrame = when (frame.getString("t")) {
    "call" -> GateFrame.Call(requireEnum(frame, "state", setOf("opening", "ready", "ending", "ended")))
    "ready" -> GateFrame.Ready(
      requireString(frame, "engine"),
      if (frame.has("resumeWindowMs") && frame.get("resumeWindowMs") != JSONObject.NULL) {
        requireNumber(frame, "resumeWindowMs").toLong()
      } else {
        null
      },
    )
    "phase" -> GateFrame.Phase(requireEnum(frame, "phase", PHASES))
    "partial" -> GateFrame.Partial(requireString(frame, "text"))
    "final" -> GateFrame.Final(requireString(frame, "turnId"), requireString(frame, "text"))
    "turn" -> {
      val error = if (frame.has("error") && frame.get("error") != JSONObject.NULL) {
        requireString(frame, "error")
      } else {
        null
      }
      GateFrame.Turn(requireString(frame, "turnId"), requireEnum(frame, "state", TURN_STATES), error)
    }
    "reply" -> GateFrame.Reply(requireString(frame, "turnId"), requireString(frame, "delta"))
    "speech" -> GateFrame.Speech(
      requireNumber(frame, "gen").toLong(),
      requireEnum(frame, "state", SPEECH_STATES),
    )
    "level" -> GateFrame.Level(requireNumber(frame, "v"))
    "approval" -> GateFrame.Approval(requireString(frame, "turnId"), requireString(frame, "summary"))
    "error" -> {
      val fatal = frame.opt("fatal")
      if (fatal !is Boolean) throw GateProtocolError("fatal must be a boolean")
      GateFrame.Error(requireString(frame, "code"), requireString(frame, "message"), fatal)
    }
    else -> GateFrame.Ended(requireString(frame, "reason"))
  }

  private fun record(json: String, types: Set<String>): JSONObject {
    if (json.toByteArray(Charsets.UTF_8).size > MAX_FRAME_BYTES) {
      throw GateProtocolError("frame is too large")
    }
    val frame = try {
      JSONObject(json)
    } catch (_: JSONException) {
      throw GateProtocolError("frame is not JSON")
    }
    val t = frame.opt("t")
    if (t !is String || t !in types) throw GateProtocolError("unknown frame type: ${t ?: "null"}")
    return frame
  }

  private fun validateEnvelope(frame: JSONObject, expectedCallId: String?): Int {
    // A v1 `level` frame uses `v` for its level (0..1), so only `v == 2` names
    // the v2 envelope, the same rule the Gate and app parsers apply.
    val version = frame.opt("v")
    if (version !is Number || version.toDouble() != 2.0) return 1
    val callId = requireString(frame, "callId")
    if (expectedCallId != null && callId != expectedCallId) throw GateProtocolError("callId does not match this call")
    val seq = requireNumber(frame, "seq")
    if (seq <= 0 || seq > 9_007_199_254_740_991.0 || seq % 1.0 != 0.0) {
      throw GateProtocolError("seq must be a positive integer")
    }
    if (requireNumber(frame, "ts") < 0) throw GateProtocolError("ts must be a non-negative finite number")
    return 2
  }

  private fun requireString(frame: JSONObject, field: String): String {
    val value = frame.opt(field)
    if (value !is String) throw GateProtocolError("$field must be a string")
    return value
  }

  private fun requireNumber(frame: JSONObject, field: String): Double {
    val value = frame.opt(field)
    if (value !is Number) throw GateProtocolError("$field must be a finite number")
    val number = value.toDouble()
    if (!number.isFinite()) throw GateProtocolError("$field must be a finite number")
    return number
  }

  private fun requireEnum(frame: JSONObject, field: String, allowed: Set<String>): String {
    val value = frame.opt(field)
    if (value !is String || value !in allowed) {
      throw GateProtocolError("$field must be one of ${allowed.joinToString(", ")}")
    }
    return value
  }
}
