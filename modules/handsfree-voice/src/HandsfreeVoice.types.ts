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

/** What the native side needs to open one call session. */
export type HandsfreeStartSessionOptions = {
  /** The Bot/surface label the operator tapped Start on. */
  title: string;
  /** This attempt's id, so a later `stopSession` can cancel exactly it. */
  startId?: string;
  /**
   * The call's own thread, as the app's own `versutus://` link. Android attaches
   * it to the ongoing notification's content intent, so a tap on the call opens
   * the conversation it belongs to rather than wherever the app was left.
   * Omitted (or a link this build does not answer) keeps the launch intent.
   */
  openUrl?: string;
};

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

/**
 * The ongoing notification's Mute/Unmute action was tapped. The service has
 * already applied it (the tap works with no JS runtime on the phone); this is
 * how the banner learns about it, so both surfaces are one state.
 */
export type HandsfreeMuteRequestEvent = {
  muted: boolean;
};

/**
 * One JSON frame from the Gate media socket, forwarded verbatim. The Gate owns
 * the call loop, so the phone only reports what it sent rather than acting on
 * it; the app maps frames to banner state in `src/lib/voice/gate-call.ts`.
 */
export type HandsfreeGateEvent = {
  frame: string;
};

/** How the Gate media socket should be opened for a Gate-powered call. */
export type HandsfreeGateMediaOptions = {
  url: string;
  token: string;
  voiceSessionId: string;
  /** Gate→phone replay cursor; supplied only when re-attaching a live call. */
  lastSeq?: number;
  /**
   * The start attempt this media link belongs to. Android refuses a delayed
   * start for an attempt a newer retry has superseded, so an old media open
   * cannot stop or replace the newer socket. Omitted on a live reconnect.
   */
  startId?: string;
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
  gate: (event: HandsfreeGateEvent) => void;
  /** Android's notification Mute/Unmute was tapped; the service applied it. */
  muteRequest: (event: HandsfreeMuteRequestEvent) => void;
};
