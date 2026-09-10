// ─── The device side of spoken replies ─────────────────────────────────────
// The one file that names `expo-speech`, kept off the rules in `speech.ts` the
// way `speech-recognition-native.ts` is kept off `speech-recognition.ts`.
//
// The package loads its native module the instant it is imported
// (`requireNativeModule('ExpoSpeech')`), which THROWS where there is no native
// side — Expo Go, and any client built before this dependency landed. A static
// import would therefore take the app down at boot rather than let the header
// ask the question, so the package is imported on the first call instead. A
// load that fails is no voice at all, never a rejection into the header; that
// is the whole reason this module exists apart from the seam, and it is also
// why the seam's calls are async.

/**
 * The speech engine this build carries, read off the package's own export the
 * way `SpeechRecognizer` is read off the recognizer's.
 */
export type SpeechEngine = typeof import('expo-speech');

/**
 * The speech engine this build carries, or null when it carries none. A load
 * that throws is the same answer as a load that finds nothing: the operator is
 * offered no speaker rather than a control whose tap could only fail.
 */
export async function loadSpeechEngine(): Promise<SpeechEngine | null> {
  try {
    return await import('expo-speech');
  } catch {
    return null;
  }
}
