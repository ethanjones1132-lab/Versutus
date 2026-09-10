// ─── Spoken replies: the queue that reads a reply aloud ────────────────────
// Solution B2 (`FUTURE-ITEMS.md:429-435`): with the speaker on, "each completed
// assistant message is spoken", a long reply is "chunked at sentence boundaries
// (respect `Speech.maxSpeechInputLength` ...) and queued in order", and "a new
// user message or toggle-off calls `Speech.stop()` and clears the queue". B6
// names this seam's Jest cases (`:477`).
//
// The cutting is `speechChunks`'s, and it is handed the platform's OWN bound —
// this file invents no bound of its own. One utterance is handed over at a
// time and the next one starts from the one before it finishing, so the queue
// is unambiguously this device's: a stop empties it in one place rather than
// trusting the platform's queue to have been emptied. The engine is the device
// seam under it (`speech-device.ts`), so a build with no native side answers
// `false` here instead of throwing into the screen.

import { speechChunks } from '@/lib/voice/speech-chunks';
import { loadSpeechEngine, type SpeechEngine } from '@/lib/voice/speech-device';

/** How one reply is read: the voice itself, and how it is spoken. */
export type ReplyVoice = {
  voiceIdentifier?: string;
  rate?: number;
  pitch?: number;
};

type SpeechOptions = NonNullable<Parameters<SpeechEngine['speak']>[1]>;

/** The chunks still to be spoken, oldest first. */
let pending: string[] = [];

/**
 * The run that owns `pending`. A stop bumps it, so a callback the platform
 * fires late for an utterance that was already stopped can never start the
 * next chunk of a reply the operator has silenced.
 */
let run = 0;

/** Whether a reply is being read right now, so the next one queues behind it. */
let speaking = false;

/** The platform's own options for one chunk: the voice, and how the chunk ends. */
function speechOptions(voice: ReplyVoice, onEnd: () => void): SpeechOptions {
  const options: SpeechOptions = { onDone: onEnd, onStopped: onEnd, onError: onEnd };
  if (voice.voiceIdentifier) options.voice = voice.voiceIdentifier;
  if (typeof voice.rate === 'number') options.rate = voice.rate;
  if (typeof voice.pitch === 'number') options.pitch = voice.pitch;
  return options;
}

/**
 * Hand the next chunk over, or finish the run. Answers whether an utterance
 * was handed to the platform, so a first chunk the platform refused can be
 * told from one it took.
 */
function advance(engine: SpeechEngine, owner: number, voice: ReplyVoice): boolean {
  if (owner !== run) return false;
  const next = pending.shift();
  if (next === undefined) {
    speaking = false;
    return false;
  }
  try {
    engine.speak(next, speechOptions(voice, () => advance(engine, owner, voice)));
    return true;
  } catch {
    // A platform that refused this chunk is not asked for the rest of it, and
    // the reply is not left half-queued behind the one that failed.
    pending = [];
    speaking = false;
    return false;
  }
}

/**
 * The voices this device offers, or none where the platform cannot say. The
 * list is handed on in the platform's own shape, unread: `botVoiceRows` in
 * `bot-voices.ts` is what decides whether a row is a voice this device can be
 * handed, so nothing here has to guess what a voice looks like. A build with
 * no engine and a list that cannot be read are both "no voice" rather than a
 * rejection into the surface that asked.
 */
export async function availableVoices(): Promise<unknown[]> {
  const engine = await loadSpeechEngine();
  if (!engine) return [];
  try {
    return await engine.getAvailableVoicesAsync();
  } catch {
    return [];
  }
}

/**
 * Whether a list this device's platform named is a voice to read a reply in.
 * This is the whole rule behind `speechAvailable`, exposed so a caller that
 * already holds the list — the picker's own refresh, which reads it for its
 * rows — can ask the seam's question of it instead of writing a second test
 * that could answer differently about the same device.
 */
export function speechAvailableFrom(voices: unknown[]): boolean {
  return voices.length > 0;
}

/**
 * Whether this device has a voice to read a reply in. The platform's own list
 * of voices is the question — the same read the picker's rows come from — so a
 * device that names none has nothing to speak with, and a list that cannot be
 * read is the same answer rather than a toggle whose tap could only be silent.
 */
export async function speechAvailable(): Promise<boolean> {
  return speechAvailableFrom(await availableVoices());
}

/**
 * Read one reply aloud: cut at sentence boundaries into as many chunks as the
 * platform's own bound allows, and queued in order behind whatever is already
 * being read. Answers whether the platform was handed an utterance — a build
 * with no engine, a reply carrying no words, a bound nothing can be spoken
 * under and a first chunk the platform refused are all `false` rather than a
 * rejection into the screen.
 */
export async function speakReply(text: string, voice: ReplyVoice = {}): Promise<boolean> {
  const engine = await loadSpeechEngine();
  if (!engine) return false;

  const chunks = speechChunks(text, engine.maxSpeechInputLength);
  if (!chunks.length) return false;

  pending.push(...chunks);
  if (speaking) return true;
  speaking = true;
  return advance(engine, run, voice);
}

/**
 * Silence the queue: the chunk being read and every chunk waiting behind it.
 * Answers nothing — the screen calls this on a new turn and on a toggle-off,
 * and has nothing to show for it.
 */
export async function stopSpeech(): Promise<void> {
  pending = [];
  run += 1;
  speaking = false;
  const engine = await loadSpeechEngine();
  if (!engine) return;
  try {
    await engine.stop();
  } catch {
    // A platform that will not stop is not asked twice.
  }
}
