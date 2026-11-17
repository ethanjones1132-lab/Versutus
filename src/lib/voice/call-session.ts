// ─── The conversation a call answers in ──────────────────────────────────
// A hands-free call speaks into a chat session. A brand-new chat and a Bot chat
// opened for the first time have none yet, and the call sheet used to refuse
// them with "send a message first" — which asked the operator to type before
// they could talk (VS-124). The thread's session is now resolved here, bounded:
// a session the app is still reading is waited on for one short window, and if
// it never lands the call proceeds without one and the Gate opens the
// conversation itself. The wait is what the sheet shows as "Getting this chat
// ready…", and it must never outlast a start: a chat with nothing to resolve
// starts at once.

/** How long Start waits for a session the app is still reading. */
export const CALL_SESSION_READY_MS = 4_000;

/** How often the wait looks again. Small enough that a fast read is not felt. */
export const CALL_SESSION_POLL_MS = 120;

/**
 * Everything `resolveCallThreadSession` needs, read at the moment it is asked.
 * A thunk per fact because the provider's mirrors (the live session, the read
 * in flight) change while the wait runs.
 */
export type CallSessionSource = {
  /** The session this chat has right now, when the app already holds one. */
  current: () => string | undefined;
  /** Whether the app is still reading this chat's session. */
  resolving: () => boolean;
  /** A session a turn sent from this chat opened while the operator was elsewhere. */
  pinned?: () => string | undefined;
  /** Open a chat for a thread that has none (the app's first-turn path). */
  open: () => Promise<string | undefined>;
};

export type CallSessionOptions = {
  /** The whole wait, not the wait per poll. */
  readyMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The session a call from this chat should speak into, or undefined when the
 * PC must open one.
 *
 * Order: what the chat already has, then a session its own first turn opened
 * while another chat was on screen, then — only while a read is still in
 * flight — a bounded wait for it to land, then one the app opens itself. A
 * chat that is not being read is never waited on: Start has to feel like a tap,
 * and the Gate can open the conversation just as well as the app can.
 *
 * Nothing here throws. A read that fails, a create that is refused and a wait
 * that times out all answer `undefined`, which the start path sends as "no
 * session" — the Gate's own conversation, adopted when the call replies.
 */
export async function resolveCallThreadSession(
  source: CallSessionSource,
  options: CallSessionOptions = {},
): Promise<string | undefined> {
  const have = source.current()?.trim();
  if (have) return have;

  const pinned = source.pinned?.()?.trim();
  if (pinned) return pinned;

  if (source.resolving()) {
    const readyMs = options.readyMs ?? CALL_SESSION_READY_MS;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? settle;
    const deadline = now() + Math.max(0, readyMs);
    while (now() < deadline) {
      await sleep(CALL_SESSION_POLL_MS);
      const landed = source.current()?.trim();
      if (landed) return landed;
    }
    // The clock can be told to stop in tests (and a poll can land exactly on the
    // deadline), so the last look is never skipped.
    const late = source.current()?.trim();
    if (late) return late;
  }

  try {
    const opened = await source.open();
    const created = opened?.trim();
    if (created) return created;
  } catch {
    // A create that threw is "no session", which the Gate answers by opening
    // the conversation itself. It is never a reason to refuse the call.
  }
  return source.current()?.trim();
}

/**
 * The session the app must adopt once a call has started.
 *
 * The app's own resolve usually names it before Start; when it did not, the
 * Gate opened one and names it back — from the start grant, or from the live
 * call's own record. Whatever id the two agree on is adopted, so the call's
 * transcript lands in this chat and the next typed message continues it.
 */
export function adoptedCallSessionId(input: {
  /** What this screen sent as the call's chat session (empty when it had none). */
  sent?: string;
  /** What the Gate named for the call, when it named one. */
  returned?: string | null;
}): string | undefined {
  const sent = input.sent?.trim();
  if (sent) return undefined;
  const returned = input.returned?.trim();
  return returned ? returned : undefined;
}
