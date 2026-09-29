/**
 * What the room has to react to, from anywhere in the app: a message sent, a
 * Bot speaking, the Gate's connection, and the operator's touch. Screens
 * write here; every mounted stage reads the same state, so the light agrees
 * across screens without threading props through the navigator.
 *
 * A send is a counter, not a timestamp: each renderer starts its own swell on
 * its own clock when the count moves (the web frame loop and the native UI
 * thread do not share a time base).
 */

import type { ConnectionStatus } from '@/lib/gateway/types';

export type StageSignalState = {
  /** Bumped once per message the operator sends. */
  sendCount: number;
  /** A Bot is replying right now. */
  speaking: boolean;
  /** The active Gate's connection; undefined when there is no Gate yet. */
  connection: ConnectionStatus | undefined;
  /** The last time the operator touched the app (ms, `Date.now()`). */
  touchedAt: number;
};

type Listener = () => void;

const listeners = new Set<Listener>();
let state: StageSignalState = { sendCount: 0, speaking: false, connection: undefined, touchedAt: 0 };

function update(patch: Partial<StageSignalState>): void {
  const next = { ...state, ...patch };
  if (
    next.sendCount === state.sendCount &&
    next.speaking === state.speaking &&
    next.connection === state.connection &&
    next.touchedAt === state.touchedAt
  ) {
    return;
  }
  state = next;
  for (const listener of listeners) listener();
}

export function getStageSignals(): StageSignalState {
  return state;
}

export function subscribeStageSignals(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The operator sent a message: the room answers with a swell of light. */
export function signalSent(): void {
  update({ sendCount: state.sendCount + 1, touchedAt: Date.now() });
}

/** A Bot started or stopped replying. */
export function signalSpeaking(speaking: boolean): void {
  update({ speaking });
}

export function signalConnection(connection: ConnectionStatus | undefined): void {
  update({ connection });
}

/**
 * The operator touched the app. Throttled to one notification a second: the
 * stage only needs to know the air may move again, not every touch.
 */
export function signalTouched(now: number = Date.now()): void {
  if (now - state.touchedAt < 1000) return;
  update({ touchedAt: now });
}

/** Test seam: back to a quiet room. */
export function resetStageSignals(): void {
  state = { sendCount: 0, speaking: false, connection: undefined, touchedAt: 0 };
  for (const listener of listeners) listener();
}
