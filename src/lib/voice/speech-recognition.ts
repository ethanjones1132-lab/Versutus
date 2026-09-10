// ─── Speech-to-text, phone-side ────────────────────────────────────────────
// Solution B's push-to-talk (FUTURE-ITEMS.md §B1): a held mic turns speech
// into text and the text lands in the composer's draft for review. Voice
// lives on the phone and text crosses the wire, so every backend the app
// supports gets voice on day one and the gateway learns nothing new.
//
// The seam drives no surface and sends nothing: it starts a session, reports
// what the recognizer heard, and stops. What the operator does with the words
// is the composer's business, one call away from here.

import { loadSpeechRecognitionModule } from '@/lib/voice/speech-recognition-native';

/**
 * What the operator's hold asks the recognizer for. Deliberately not the
 * package's whole option surface: the few knobs a hold needs, so the surface
 * cannot configure a session the seam is not built for.
 */
export type SpeechRecognitionStartOptions = {
  /** BCP-47 language, e.g. `en-GB`; the platform's own default when absent. */
  lang?: string;
  /** Keep listening past the first pause instead of ending on it. */
  continuous?: boolean;
  /** Recognise on the phone rather than over the network. */
  requiresOnDeviceRecognition?: boolean;
};

/**
 * A live transcript as the recognizer reports it: the words so far, and
 * whether the platform has finished deciding them. A partial arrives many
 * times over a hold and the final one arrives once, on `stop` — the seam
 * reports both and marks which is which rather than guessing.
 */
export type SpeechTranscriptListener = (transcript: string, isFinal: boolean) => void;

type SpeechSubscription = { remove: () => void };

/**
 * The live hold, if any. One session at a time: starting a second hold
 * retires the first, so two listeners can never report the same microphone
 * into the same draft.
 */
let activeSubscriptions: SpeechSubscription[] = [];

/** Retire the live hold's listeners. Safe to call with no hold, or twice. */
function releaseSession(): void {
  const subscriptions = activeSubscriptions;
  activeSubscriptions = [];
  subscriptions.forEach((subscription) => subscription.remove());
}

/**
 * Whether this build can hear at all. A client with no native module, or a
 * platform that cannot answer the question, is `false` — the composer then
 * draws no mic rather than a control that cannot finish.
 */
export async function speechRecognitionAvailable(): Promise<boolean> {
  const recognizer = await loadSpeechRecognitionModule();
  if (!recognizer) return false;

  try {
    return recognizer.isRecognitionAvailable();
  } catch {
    return false;
  }
}

/**
 * Begin a hold, reporting each transcript to `onTranscript`. Answers whether
 * a session actually started, so a surface can tell a live mic from a refusal
 * instead of buzzing over silence. A recognizer that will not start — or a
 * client that has none — leaves no listener behind.
 *
 * Interim results are the seam's own decision rather than a caller's option:
 * a transcript that arrives while the operator is still speaking is the point
 * of the control.
 */
export async function startSpeechRecognition(
  options: SpeechRecognitionStartOptions,
  onTranscript: SpeechTranscriptListener,
): Promise<boolean> {
  const recognizer = await loadSpeechRecognitionModule();
  if (!recognizer) return false;

  try {
    releaseSession();
    activeSubscriptions = [
      recognizer.addListener('result', (event) => {
        onTranscript(event.results[0]?.transcript ?? '', event.isFinal);
      }),
      // The session's own end retires the listeners. `stop` leaves them up on
      // purpose: it asks the platform for a final result, which arrives on
      // this same listener before the end does.
      recognizer.addListener('end', releaseSession),
      recognizer.addListener('error', releaseSession),
    ];
    recognizer.start({ ...options, interimResults: true });
    return true;
  } catch {
    releaseSession();
    return false;
  }
}

/**
 * End the hold and keep what was said. The platform answers with a final
 * result on the listener this session still holds; the session's own end
 * retires it. A stop the platform refuses will never emit that end, so the
 * listeners go here instead of waiting forever.
 */
export async function stopSpeechRecognition(): Promise<void> {
  const recognizer = await loadSpeechRecognitionModule();
  if (!recognizer) return;

  try {
    recognizer.stop();
  } catch {
    releaseSession();
  }
}

/**
 * End the hold and throw away what was said. An abort returns no final
 * result, so the listeners are retired first — anything the platform still
 * reports afterwards is not the operator's message.
 */
export async function cancelSpeechRecognition(): Promise<void> {
  releaseSession();

  const recognizer = await loadSpeechRecognitionModule();
  if (!recognizer) return;

  try {
    recognizer.abort();
  } catch {
    // Nothing to answer: the hold is already retired.
  }
}
