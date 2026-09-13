package com.versutus.handsfreevoice

import org.json.JSONException
import org.json.JSONObject

const val MAX_FRAME_BYTES = 4096

/** A parsed Gate → phone media frame, the Kotlin mirror of `parseGateFrame`. */
sealed class GateFrame {
  abstract val t: String

  data class Ready(val engine: String) : GateFrame() {
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
    "ready", "phase", "partial", "final", "turn", "reply", "speech", "level", "approval", "error", "ended",
  )
  private val PHONE_TYPES = setOf("mute", "skip", "bargein", "end")
  private val PHASES = setOf("listening", "thinking", "speaking", "muted")
  private val TURN_STATES = setOf("sent", "replying", "done", "failed")
  private val SPEECH_STATES = setOf("start", "end", "cancelled")

  fun parse(json: String): GateFrame = fromGateRecord(record(json, GATE_TYPES))

  fun parsePhone(json: String): GateFrame.Phone {
    val frame = record(json, PHONE_TYPES)
    return when (frame.getString("t")) {
      "mute" -> {
        val on = frame.opt("on")
        if (on !is Boolean) throw GateProtocolError("on must be a boolean")
        GateFrame.Phone.Mute(on)
      }
      "skip" -> GateFrame.Phone.Skip
      "bargein" -> GateFrame.Phone.BargeIn
      else -> GateFrame.Phone.End
    }
  }

  fun encodePhone(frame: GateFrame.Phone): String = when (frame) {
    is GateFrame.Phone.Mute -> JSONObject().put("t", frame.t).put("on", frame.on).toString()
    else -> JSONObject().put("t", frame.t).toString()
  }

  private fun fromGateRecord(frame: JSONObject): GateFrame = when (frame.getString("t")) {
    "ready" -> GateFrame.Ready(requireString(frame, "engine"))
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
