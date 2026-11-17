// ─── The conversation a chat opened while the operator was elsewhere ──────
// A turn sent from a thread that has no session yet makes the Gate open one on
// the first reply, and the header that names it arrives whenever the model has
// answered — often after the operator has moved to another room. Adopting that
// id as "the current session" whatever is on screen pinned one chat's
// conversation onto another (typed messages in a Bot room continued a chat
// thread). The id is kept for the chat the turn was SENT from instead, under
// the same key that chat's composer draft uses, so coming back to it picks the
// conversation up again. Nothing here touches React: the provider owns the
// state and only asks this module what to keep.

import { composerDraftKey, composerDraftThread } from '@/lib/gateway/composer-draft';
import { keyValueStorage } from '@/lib/storage/key-value';

/**
 * The chat a turn was sent from, without its session: a Bot names itself, and
 * anything else is the one configurable thread this gateway keeps.
 */
export type TurnThread = {
  gatewayId: string;
  botId?: string;
};

/** Where the pins are persisted. Best-effort: losing them costs a thread its session. */
export const THREAD_SESSION_PINS_KEY = 'versutus:thread-session-pins';

/** A chat's key → the session its first turn opened. */
export type ThreadSessionPins = Record<string, string>;

/**
 * The key of a chat that has no session yet. Built through `composerDraftKey`
 * rather than by hand so it can never drift from the key the composer's own
 * draft is stored under — the pin and the draft belong to one thread.
 */
export function sessionlessThreadKey(thread: TurnThread): string | undefined {
  const draft = composerDraftThread({
    gatewayId: thread.gatewayId,
    surface: thread.botId
      ? { kind: 'bot' as const, botId: thread.botId }
      : { kind: 'configurable' as const },
    sessionId: undefined,
  });
  return draft ? composerDraftKey(draft) : undefined;
}

/** One chat's session, or undefined when its first turn has not named one. */
export function readThreadSessionPin(
  pins: ThreadSessionPins,
  thread: TurnThread,
): string | undefined {
  const key = sessionlessThreadKey(thread);
  if (!key) return undefined;
  const sessionId = pins[key]?.trim();
  return sessionId ? sessionId : undefined;
}

/** Record a session for the chat a turn was sent from, leaving every other chat alone. */
export function writeThreadSessionPin(
  pins: ThreadSessionPins,
  thread: TurnThread,
  sessionId: string,
): ThreadSessionPins {
  const key = sessionlessThreadKey(thread);
  const value = sessionId.trim();
  if (!key || !value || pins[key] === value) return pins;
  return { ...pins, [key]: value };
}

/** Forget a chat's session — a deliberately new thread must not inherit the old one. */
export function clearThreadSessionPin(
  pins: ThreadSessionPins,
  thread: TurnThread,
): ThreadSessionPins {
  const key = sessionlessThreadKey(thread);
  if (!key || pins[key] === undefined) return pins;
  const next = { ...pins };
  delete next[key];
  return next;
}

/** Anything that is not a non-empty string is not a pin. */
export function threadSessionPinsFromUnknown(value: unknown): ThreadSessionPins {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const pins: ThreadSessionPins = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && entry.trim()) pins[key] = entry.trim();
  }
  return pins;
}

/**
 * What to do with a session the Gate named for a turn that was sent from
 * `sent`. Adopt it only while the chat it was sent from is still the one on
 * screen; otherwise keep it for that chat. Two chats never share it.
 */
export function adoptTurnSession(input: {
  sent: TurnThread;
  open: TurnThread;
  sessionId: string;
}): 'adopt' | 'pin' {
  if (input.sent.gatewayId !== input.open.gatewayId) return 'pin';
  if ((input.sent.botId ?? '') !== (input.open.botId ?? '')) return 'pin';
  return 'adopt';
}

/** Read the stored pins; a storage refusal is an empty store, never a throw. */
export async function loadThreadSessionPins(): Promise<ThreadSessionPins> {
  try {
    const raw = await keyValueStorage.getItem(THREAD_SESSION_PINS_KEY);
    if (!raw) return {};
    return threadSessionPinsFromUnknown(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Write the pins; best-effort, because a pin is a convenience and not a turn. */
export async function saveThreadSessionPins(pins: ThreadSessionPins): Promise<void> {
  try {
    await keyValueStorage.setItem(THREAD_SESSION_PINS_KEY, JSON.stringify(pins));
  } catch {
    // A refused write costs the chat its session on the next launch, nothing more.
  }
}
