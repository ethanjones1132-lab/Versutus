// ─── Opening a Gate-powered call, without the React provider ──────────────
// The provider used to swallow every `voice.session.start` failure into
// `'unavailable'`. This is the same sequence the provider runs, injectable so
// a test can drive it against a fake Gate and assert that a call opens.
//
// The chain is also bounded, end to end (see `start-deadline`): a link that
// never answers used to leave the call in `starting` for the life of the
// process, which meant the user could never press Call a second time. That
// includes the release — a `voice.session.stop` issued to clean up a start
// that already failed is a promise from the same Gate, and waiting on it
// unbounded would strand the start in exactly the way the deadline exists to
// prevent. So it is issued and raced with the same budget: best effort, and
// never the thing that keeps the call from coming home to `idle`.

import { GATE_LINK_READY_MS, type GateLinkProof } from '@/lib/voice/gate-link';
import { mediaSocketUrl } from '@/lib/voice/gate-media-url';
import { HANDSFREE_START_TIMEOUT_MS, isStartTimeout, startDeadline } from '@/lib/voice/start-deadline';
import {
  logHandsfreeStart,
  mapGateSessionStartFailure,
  parseVoiceSessionGrant,
  type GateVoiceGrant,
  type HandsfreeStartAttempt,
  type HandsfreeStartLog,
} from '@/lib/voice/handsfree-start-reason';

type StartDeadline = ReturnType<typeof startDeadline>;

// Every attempt carries its own id. Cancelling names that exact id, so a
// cleanup that runs after a newer retry has claimed the native side is a no-op
// there rather than an unkeyed `stopSession` that supersedes the new owner and
// ends its live call. The random suffix keeps a JS reload from reusing an id a
// service that outlived the reload still holds.
let startIdSeq = 0;
export function newHandsfreeStartId(): string {
  startIdSeq += 1;
  return `hs-${startIdSeq.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export type OpenGateVoiceSessionInput = {
  gatewayUrl: string;
  gatewayToken: string;
  target: {
    label: string;
    voiceEngine?: string;
    surfaceKind: 'configurable' | 'bot';
    sessionId: string;
    botId?: string;
  };
  device: { deviceId: string };
  gatewayRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Opens the native session; the `startId` is the key its cancellation uses. */
  startSession?: (
    title: string,
    startId: string,
  ) => Promise<'started' | 'permission-denied' | 'unavailable'>;
  /**
   * Cancels the native start if JS abandons it while a permission dialog is
   * still up OR after it opened but the media link could not be joined. Always
   * named with that attempt's own `startId`, so a new retry's service is
   * untouched: a newer retry claims a newer id and owns its own service.
   */
  cancelStartSession?: (startId: string) => Promise<void> | void;
  /** The attempt id; generated when omitted so tests can pin it. */
  startId?: string;
  startGateMedia: (options: {
    url: string;
    token: string;
    voiceSessionId: string;
    /** The attempt this media link belongs to; the native side keys on it. */
    startId: string;
  }) => Promise<boolean>;
  /**
   * Proves the audio link is really up, by waiting for the Gate's first frame on
   * it. `startGateMedia` answers as soon as the socket was handed over and has
   * no open event, so its boolean is not evidence: a dead link used to report
   * `started` and leave the call listening to nothing for the life of the call.
   * Anything other than `'frame'` is the same failure a `false` boolean is.
   */
  proveLink?: (budgetMs: number) => Promise<GateLinkProof>;
  /** How long the link may take to speak before the start gives up on it. */
  linkReadyMs?: number;
  mediaUrl?: (base: string, path: string) => string;
  log?: (event: HandsfreeStartLog) => void;
  now?: () => string;
  /**
   * The budget for the WHOLE Gate start, including the device identity read that
   * runs before this chain. `startGateCall` mints one and hands it here, so the
   * two links cannot each spend a full timeout. Without it this chain mints its
   * own, exactly as before. A borrowed budget is not disposed here: its owner
   * disposes it when the start has settled.
   */
  deadline?: StartDeadline;
  /** How long the whole chain may take before the start is abandoned. */
  startTimeoutMs?: number;
};

async function stopGrantedSession(
  gatewayRequest: OpenGateVoiceSessionInput['gatewayRequest'],
  voiceSessionId: string | undefined,
  deadline: StartDeadline,
): Promise<void> {
  if (!voiceSessionId) return;
  try {
    await deadline.guard(
      'the release of the call',
      gatewayRequest('voice.session.stop', { voiceSessionId, reason: 'start-failed' }),
    );
  } catch {
    // Best effort, and bounded: the session's own idle close, or the Gate's
    // attach grace, ends it if this never lands. A release that hangs must not
    // become the new way to strand the start.
  }
}

/**
 * The native start is a permission dialog as much as it is a service. When JS
 * abandons it, the native side may still answer — and a late grant would open
 * the microphone with no call behind it. Cancel that exact attempt so it is
 * discarded; because the retry this phone is about to offer claims a newer
 * attempt id, the cancellation cannot reach it.
 *
 * Issued and forgotten, exactly like the late-grant release: the budget is
 * already spent, and a local cancel that never answers must not become the new
 * way to strand the start. Invoking it is what matters — the attempt is
 * superseded natively before the retry can claim a newer one.
 */
export function cancelNativeStart(
  cancel: OpenGateVoiceSessionInput['cancelStartSession'],
  startId: string,
): void {
  if (!cancel) return;
  try {
    void Promise.resolve(cancel(startId)).catch(() => undefined);
  } catch {
    // A synchronous throw still leaves the attempt abandoned on the JS side.
  }
}

/**
 * A `voice.session.start` that lost the race can still answer afterwards. The
 * timeout path has already stopped reading it, so nothing awaits the result —
 * but the Gate has still granted a session, and leaving it live makes the next
 * start `call_in_progress`. Attach to that exact request: when (and only when)
 * it finally names a session, issue a stop for the id it names. A newer attempt
 * has an id of its own, so this cannot touch it, and the budget is already
 * spent, so the release is issued and forgotten rather than waited on.
 */
function releaseLateGrant(
  gatewayRequest: OpenGateVoiceSessionInput['gatewayRequest'],
  startRequest: Promise<unknown>,
  deadline: StartDeadline,
): void {
  void startRequest
    .then((late) => {
      const lateGrant = parseVoiceSessionGrant(late);
      if (!lateGrant) return undefined;
      return stopGrantedSession(gatewayRequest, lateGrant.voiceSessionId, deadline);
    })
    .catch(() => {
      // A late refusal is not a grant; a late transport error has nothing to release.
    });
}

function finish(
  attempt: HandsfreeStartAttempt,
  log: (event: HandsfreeStartLog) => void,
  extra: { engine?: string } = {},
): HandsfreeStartAttempt {
  log({
    result: attempt.result,
    transport: 'gate',
    engine: extra.engine,
    detail: attempt.detail,
  });
  return attempt;
}

/**
 * Grant a Gate voice session, take the microphone, and open the media socket.
 * A grant that cannot be joined is stopped so the next start is not
 * `call_in_progress`, and every link — the grant, the prompt, the media socket
 * and the release itself — is raced against one budget so a link that never
 * answers is abandoned rather than leaving the call in `starting` forever. The
 * caller may hand in the budget it already started (see `deadline`), which is
 * what keeps the device identity read and this chain inside one timeout. A
 * timeout names the link that went quiet, because "the start failed" was never
 * enough to tell a wedged Gate from a wedged microphone prompt.
 */
export async function openGateVoiceSession(
  input: OpenGateVoiceSessionInput,
): Promise<HandsfreeStartAttempt & { grant?: GateVoiceGrant }> {
  const log = input.log ?? logHandsfreeStart;
  const toMediaUrl = input.mediaUrl ?? mediaSocketUrl;
  // A budget the caller already started spends with the call, not with this
  // function: only one minted here is this function's to dispose.
  const ownDeadline = input.deadline
    ? undefined
    : startDeadline(input.startTimeoutMs ?? HANDSFREE_START_TIMEOUT_MS);
  const deadline = input.deadline ?? ownDeadline!;
  // This attempt's native key. Cancellation names it, so cleanup for an
  // abandoned attempt can never reach the service a newer retry owns.
  const startId = input.startId ?? newHandsfreeStartId();

  // Held outside the try so an expiry after the grant can still release it: a
  // timeout that left the grant taken would make the retry `call_in_progress`.
  let grant: GateVoiceGrant | null = null;
  // Whether the native start was invoked at all. Once it was, every later
  // failure must cancel this exact attempt: a native session left behind holds
  // the microphone with no call behind it, and a late grant could open one
  // during the retry this failure invites. Keyed by `startId`, so cleanup can
  // never reach the service a newer retry owns.
  let nativeInvoked = false;

  try {
    let raw: unknown;
    let startRequest: Promise<unknown> | undefined;
    try {
      startRequest = input.gatewayRequest('voice.session.start', {
        engine: input.target.voiceEngine ?? 'auto',
        thread: {
          kind: input.target.surfaceKind,
          sessionId: input.target.sessionId,
          botId: input.target.botId,
        },
        disclosureAcceptedAt: (input.now ?? (() => new Date().toISOString()))(),
        ...input.device,
      });
      raw = await deadline.guard('the PC', startRequest);
    } catch (error) {
      if (isStartTimeout(error)) {
        // The budget ran out while the start RPC was still in flight. That
        // request may answer later with a live session — release whatever it
        // names, so the retry this phone is about to offer is not refused as
        // call-in-progress. Native start and media are never reached from here.
        if (startRequest) releaseLateGrant(input.gatewayRequest, startRequest, deadline);
        throw error;
      }
      const mapped = mapGateSessionStartFailure(error);
      return finish({ result: mapped.result, detail: mapped.detail }, log);
    }

    const parsed = parseVoiceSessionGrant(raw);
    if (!parsed) {
      return finish({ result: 'session-grant-incomplete' }, log);
    }
    grant = parsed;

    if (input.startSession) {
      let sessionOutcome: 'started' | 'permission-denied' | 'unavailable';
      try {
        nativeInvoked = true;
        sessionOutcome = await deadline.guard(
          'the microphone prompt',
          input.startSession(input.target.label, startId),
        );
      } catch (error) {
        // A timeout is rethrown and cancelled once by the outer handler,
        // together with the grant release. A rejection is the native call's
        // own failure, mapped to unavailable below.
        if (isStartTimeout(error)) throw error;
        sessionOutcome = 'unavailable';
      }
      if (sessionOutcome !== 'started') {
        // The start did not take: cancel the exact native attempt so a late
        // answer cannot open a microphone during the retry this refusal invites.
        cancelNativeStart(input.cancelStartSession, startId);
        await stopGrantedSession(input.gatewayRequest, parsed.voiceSessionId, deadline);
        return finish(
          {
            result: sessionOutcome === 'permission-denied'
              ? 'permission-denied'
              : 'native-session-unavailable',
          },
          log,
          { engine: parsed.engine },
        );
      }
    }

    let started = false;
    try {
      started = await deadline.guard(
        'the audio link',
        input.startGateMedia({
          url: toMediaUrl(input.gatewayUrl, parsed.streamPath),
          token: input.gatewayToken,
          voiceSessionId: parsed.voiceSessionId,
          // The media link belongs to this attempt. The native side refuses a
          // delayed start for an abandoned attempt, so it can never stop or
          // replace the socket a newer retry owns.
          startId,
        }),
      );
    } catch (error) {
      if (isStartTimeout(error)) throw error;
      started = false;
    }
    // The socket was handed to the network stack. Nothing has proved the Gate is
    // on the other end of it yet, and every failure from here arrives later as a
    // frame rather than as a rejection — so the link is waited on, and a link
    // that never speaks is the same failed attempt a `false` boolean is. A
    // socket that was refused outright is not waited on: there is nothing to
    // wait for.
    let spoken: GateLinkProof | null = null;
    if (started && input.proveLink) {
      try {
        spoken = await deadline.guard(
          'the audio link',
          input.proveLink(input.linkReadyMs ?? GATE_LINK_READY_MS),
        );
      } catch (error) {
        if (isStartTimeout(error)) throw error;
        spoken = 'failed';
      }
    }
    if (!started || (spoken !== null && spoken !== 'frame')) {
      // The native session opened but could not be joined. Cancel it by its own
      // id so the microphone does not stay live with no media path behind the
      // retry this failure invites, then release the grant so the retry is not
      // refused as `call_in_progress`.
      cancelNativeStart(input.cancelStartSession, startId);
      await stopGrantedSession(input.gatewayRequest, parsed.voiceSessionId, deadline);
      return finish(
        {
          result: 'media-start-failed',
          // The two failures are the same refusal with different evidence, and
          // only one of them can be seen from here: the socket dying said so
          // itself, and silence did not.
          ...(spoken && spoken !== 'frame'
            ? { detail: spoken === 'failed'
              ? 'the audio link failed before the PC spoke on it'
              : 'the PC never spoke on the audio link' }
            : {}),
        },
        log,
        { engine: parsed.engine },
      );
    }

    log({ result: 'started', transport: 'gate', engine: parsed.engine });
    return { result: 'started', grant: parsed };
  } catch (error) {
    if (isStartTimeout(error)) {
      // The native start, if it was invoked, is cancelled by its own id: a
      // session left live holds the microphone with no call. The grant, if it
      // ever arrived, is released so the retry this phone is about to be
      // offered is not refused as call-in-progress. The budget is already
      // spent, so the release is issued and not waited for: the Gate answers
      // it in the background, and nothing about this start depends on a Gate
      // that has just proved it does not answer.
      if (nativeInvoked) cancelNativeStart(input.cancelStartSession, startId);
      await stopGrantedSession(input.gatewayRequest, grant?.voiceSessionId, deadline);
      return finish(
        { result: 'start-timed-out', detail: error.message },
        log,
        { engine: grant?.engine },
      );
    }
    throw error;
  } finally {
    ownDeadline?.dispose();
  }
}
