// ─── Speech-to-text, phone-side ────────────────────────────────────────────
// Solution B's push-to-talk (FUTURE-ITEMS.md §B1): a held mic turns speech
// into text and the text lands in the composer's draft for review. Voice
// lives on the phone and text crosses the wire, so every backend the app
// supports gets voice on day one and the gateway learns nothing new.
//
// The seam drives no surface and sends nothing: it asks the phone for the
// microphone and speech recognition, starts a session, reports what the
// recognizer heard, and stops. What the operator does with the words is the
// composer's business, one call away from here.

import {
  loadSpeechRecognitionModule,
  type SpeechRecognizer,
} from '@/lib/voice/speech-recognition-native';

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

/** What the platform's permission call answers, read off the one seam type. */
type PermissionAnswer = Awaited<ReturnType<SpeechRecognizer['getPermissionsAsync']>>;

/**
 * Whether a hold can be offered on this phone, read from the platform's own
 * response. Two ways to be askable: the phone has already granted the two, or
 * the platform will still put its own dialog up — `canAskAgain`, whose own doc
 * says a phone that cannot be asked again has to be sent to the Settings app.
 * A phone whose refusal the platform will not re-ask is the only one a hold
 * cannot be offered on, and a question that cannot be answered — a recognizer
 * with no permission module, a platform that throws — is not askable either, so
 * no hold is ever offered on a guess.
 */
async function readPermissionAskable(recognizer: SpeechRecognizer): Promise<boolean> {
  try {
    const answer: PermissionAnswer = await recognizer.getPermissionsAsync();
    return answer.granted || answer.canAskAgain;
  } catch {
    return false;
  }
}

/** Put the platform's own dialog up and answer whether the operator granted. */
async function askPermission(recognizer: SpeechRecognizer): Promise<boolean> {
  try {
    return (await recognizer.requestPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

/**
 * Whether a hold can be offered on this phone. The platform's own answer is the
 * record: a granted phone is askable, and so is a phone the platform will still
 * ask — a fresh install whose operator has never been asked, or a denial the
 * platform lets us re-ask. Only a refusal it will not re-ask (and a build that
 * cannot answer the question at all) is not askable, so the control is drawn
 * refused exactly where a hold would have nothing to start.
 */
export async function speechRecognitionPermissionAskable(): Promise<boolean> {
  const recognizer = await loadSpeechRecognitionModule();
  if (!recognizer) return false;

  return readPermissionAskable(recognizer);
}

/**
 * Ask the phone for the microphone and speech recognition, and answer whether
 * it was granted. The config plugin only DECLARES the two — iOS reads the
 * strings into Info.plist and Android gets RECORD_AUDIO — and neither platform
 * grants them from the manifest, so this is the only place either one is
 * actually asked.
 *
 * A refusal is an answer rather than an error: the operator declined once, and
 * only the device settings can change that, so nothing here re-asks.
 */
export async function requestSpeechRecognitionPermission(): Promise<boolean> {
  const recognizer = await loadSpeechRecognitionModule();
  if (!recognizer) return false;

  return askPermission(recognizer);
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
 * The phone is asked for the microphone and speech recognition HERE, before
 * any listener is subscribed: the config plugin only declares the two, so
 * without this the first hold on a device whose operator has never been asked
 * would fail with nothing to show for it. A device that has not granted starts
 * no session at all — and `requestPermissionsAsync` raises its dialog only
 * once, so the operator meets the platform's own prompt and never a second one.
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

  if (!(await askPermission(recognizer))) return false;

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
