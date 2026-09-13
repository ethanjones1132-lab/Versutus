// ─── A scripted voice engine for tests and the phone smoke test ───────────
// It implements the §4.5 engine interface without a model: audio in becomes a
// fixture `final`, and `speak` answers silence PCM of a length derived from the
// text, tagged with the generation. Deterministic and synchronous, so the call
// loop can be exercised end to end with no device and no network.

import { EventEmitter } from 'node:events';

const FRAME_MS = 20;
export const SCRIPTED_SAMPLE_RATE = 24000;
export const SCRIPTED_FRAME_BYTES = ((SCRIPTED_SAMPLE_RATE * FRAME_MS) / 1000) * 2; // 960

function silenceFrame() {
  return Buffer.alloc(SCRIPTED_FRAME_BYTES);
}

/** Whether the env asks for the scripted engine (the phone smoke test sets this). */
export function scriptedEngineEnabled(env = process.env) {
  return env.VERSUTUS_VOICE_SCRIPTED === '1';
}

export class ScriptedEngine extends EventEmitter {
  constructor({
    text = 'hello from the scripted engine',
    framesBeforeFinal = 1,
    msPerChar = 50,
    minSpeechMs = 200,
  } = {}) {
    super();
    this.id = 'scripted';
    this.text = text;
    this.framesBeforeFinal = framesBeforeFinal;
    this.msPerChar = msPerChar;
    this.minSpeechMs = minSpeechMs;
    this.framesSeen = 0;
    this.muted = false;
    this.closed = false;
    this.cancelled = new Set();
  }

  /** Open the engine for a call. */
  async open() {
    this.closed = false;
    this.framesSeen = 0;
  }

  /** 20 ms PCM16LE mono 16 kHz from the phone. */
  pushAudio() {
    if (this.closed || this.muted) return;
    this.framesSeen += 1;
    if (this.framesSeen >= this.framesBeforeFinal) {
      this.framesSeen = 0;
      this.emit('final', { text: this.text });
    }
  }

  /** The silence length a spoken chunk earns, in ms. */
  durationMs(text) {
    return Math.max(this.minSpeechMs, text.length * this.msPerChar);
  }

  /** Voice supplied text. A cancelled generation answers nothing. */
  speak(text, { gen } = {}) {
    if (this.closed || this.muted) return;
    if (gen !== undefined && this.cancelled.has(gen)) return;
    const frames = Math.max(1, Math.ceil(this.durationMs(text) / FRAME_MS));
    for (let i = 0; i < frames; i += 1) {
      if (gen !== undefined && this.cancelled.has(gen)) return;
      this.emit('speechAudio', { gen, pcm: silenceFrame() });
    }
    if (gen !== undefined && this.cancelled.has(gen)) return;
    this.emit('speechDone', { gen });
  }

  /** Drop anything still pending for one generation. */
  cancelSpeech(gen) {
    if (gen !== undefined) this.cancelled.add(gen);
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
  }

  async close() {
    this.closed = true;
  }
}
