// ─── The native hands-free voice contract ─────────────────────────────────
// One user-started, half-duplex call session: the native side owns the
// microphone, the audio session and the reply voice; this file is the typed
// shape of the calls it answers and the events it reports back. Nothing here
// speaks, records or decides when a turn ends — that is the JS reducer's, and
// the native side only supplies what it observed.

/** What this device can actually do for a call, asked before one starts. */
export type HandsfreeAvailability = {
  /** Whether this platform can recognize speech for the call. */
  recognition: boolean;
  /** Whether this platform can synthesize the reply. */
  synthesis: boolean;
  /**
   * The platform's own maximum length one synthesized chunk may carry. Android
   * is finite, iOS is effectively unbounded; the call path speaks in chunks
   * this size rather than inventing a bound of its own.
   */
  maxSpeechInputLength: number;
};

/** How a request to open a call session resolved. */
export type HandsfreeStartOutcome = 'started' | 'permission-denied' | 'unavailable';

/** One reply to speak, already cut into ordered chunks by the caller. */
export type HandsfreeSpeakOptions = {
  chunks: string[];
  voiceIdentifier?: string;
  rate?: number;
  pitch?: number;
};

/** A live transcript so far. Never a completed turn — see `HandsfreeFinalEvent`. */
export type HandsfreePartialEvent = {
  text: string;
};

/** One completed recognized utterance, already trimmed. */
export type HandsfreeFinalEvent = {
  text: string;
};

/** Silence with no words. Nothing was recognized, nothing should send. */
export type HandsfreeNoSpeechEvent = {
  reason?: string;
};

/** The last queued chunk finished speaking. */
export type HandsfreeSpeechFinishedEvent = {
  reason?: string;
};

/** The audio session was taken by another app, a call, or a route change. */
export type HandsfreeInterruptionEvent = {
  reason?: string;
};

/**
 * Android's ongoing-notification End action asked for the call to end. iOS has
 * no such action, so this event never fires there. It is the notification's
 * half of End; the service's own teardown is the other half.
 */
export type HandsfreeEndRequestedEvent = {
  reason?: string;
};

/** A recognition or synthesis failure the call cannot recover from. */
export type HandsfreeFatalErrorEvent = {
  reason: 'recognition-failed' | 'speech-failed';
  message?: string;
};

/** Voice was detected during `speaking`; the reply was stopped for a new turn. */
export type HandsfreeBargeInEvent = {
  reason?: string;
};

/** A periodic 0–1 amplitude sample for the ambient call indicator. */
export type HandsfreeLevelEvent = {
  level: number;
};

export type HandsfreeVoiceModuleEvents = {
  partial: (event: HandsfreePartialEvent) => void;
  final: (event: HandsfreeFinalEvent) => void;
  noSpeech: (event: HandsfreeNoSpeechEvent) => void;
  speechFinished: (event: HandsfreeSpeechFinishedEvent) => void;
  interruption: (event: HandsfreeInterruptionEvent) => void;
  endRequested: (event: HandsfreeEndRequestedEvent) => void;
  fatalError: (event: HandsfreeFatalErrorEvent) => void;
  bargeIn: (event: HandsfreeBargeInEvent) => void;
  level: (event: HandsfreeLevelEvent) => void;
};
