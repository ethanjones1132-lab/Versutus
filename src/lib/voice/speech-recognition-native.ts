// ─── The device side of speech-to-text ─────────────────────────────────────
// The one file that names `expo-speech-recognition`, kept off the rules in
// `speech-recognition.ts` the way `app-lock-device.ts` is kept off
// `app-lock.ts`.
//
// The package loads its native module the instant it is imported
// (`requireNativeModule('ExpoSpeechRecognition')`), which THROWS where there
// is no native side — Expo Go, and any client built before the config plugin
// ran a prebuild. A static import would therefore take the app down at boot
// rather than let a surface ask the question, so the package is imported on
// the first call instead. A load that fails is no recognizer at all, never a
// rejection into the composer; that is the whole reason this module exists
// apart from the seam, and it is also why the seam's calls are async.

/**
 * The recognizer object the package hands over once its native module is
 * loaded. The package exports the value and not the class behind it, so the
 * shape is read off the export itself.
 */
export type SpeechRecognizer = typeof import('expo-speech-recognition').ExpoSpeechRecognitionModule;

/**
 * The speech recognizer this build carries, or null when it carries none.
 * A load that throws is the same answer as a load that finds nothing: the
 * operator is offered no mic rather than a control that cannot finish.
 */
export async function loadSpeechRecognitionModule(): Promise<SpeechRecognizer | null> {
  try {
    const speechRecognition = await import('expo-speech-recognition');
    return speechRecognition.ExpoSpeechRecognitionModule;
  } catch {
    return null;
  }
}
