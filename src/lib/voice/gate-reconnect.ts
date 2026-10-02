// ─── Rejoining a Gate call after the media socket drops ───────────────────
// The Gate holds a detached call open for its resume window (20 s) and
// re-attaches a socket that arrives with the same voiceSessionId. The phone
// used to treat any socket failure as fatal and end the call inside that
// window, so one Wi-Fi blip killed an otherwise healthy call. This is the
// retry half of that contract: retry startGateMedia with the same grant, with
// backoff, for no longer than the Gate will hold the call. Teardown at any
// point wins — the caller's isAborted() is checked before every attempt.
//
// An attempt is only an attempt's success when the Gate is proved back on the
// socket it opened (`proveLink`): the boolean says the socket was handed over,
// and a call that accepted that ran the whole window on a link nobody was on.

import { GATE_LINK_READY_MS, type GateLinkProof } from '@/lib/voice/gate-link';
import { mediaSocketUrl } from '@/lib/voice/gate-media-url';
import type { GateVoiceGrant } from '@/lib/voice/handsfree-start-reason';

/**
 * The fallback re-attach budget, used only when the Gate has not advertised its
 * own window in a `ready` frame. A current Gate sends `resumeWindowMs`
 * (`RESUME_TIMEOUT_MS` in gate/core/voice/media-socket.mjs, 90 s) and the
 * provider passes it as `windowMs`; the phone must spend its whole retry budget
 * inside the Gate's window or the re-attach 404s. 20 s is what an older Gate
 * that advertises nothing was understood to hold.
 */
export const GATE_RECONNECT_WINDOW_MS = 20_000;

/**
 * How much of the window the last attempt leaves open for its own round trip.
 * The schedule used to sum to exactly the window, so the final delay put the
 * last attempt on the deadline itself — past the point where the Gate is still
 * holding the call — and the loop spent that tail asleep. This is the room the
 * last shot now keeps.
 */
export const GATE_RECONNECT_SAFETY_MARGIN_MS = 2_500;

/**
 * How long one attempt is assumed to take. An attempt with less than this left
 * cannot finish inside the window, so issuing it buys one more refusal and no
 * re-attach; one that starts with this much room is allowed to run.
 */
const ATTEMPT_ROUND_TRIP_MS = 1_000;

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000];

/** The delay before each reconnect attempt, fitted inside the window. */
export function gateReconnectDelays(windowMs = GATE_RECONNECT_WINDOW_MS): number[] {
  const delays: number[] = [];
  let spent = 0;
  for (const step of BACKOFF_MS) {
    if (spent + step > windowMs) break;
    delays.push(step);
    spent += step;
  }
  // One shot for the last moment of the window — landing before it closes, so
  // the attempt is issued rather than slept through.
  const last = windowMs - GATE_RECONNECT_SAFETY_MARGIN_MS - spent;
  if (last > 0) delays.push(last);
  return delays;
}

export type ReconnectGateMediaInput = {
  grant: GateVoiceGrant;
  gatewayUrl: string;
  gatewayToken: string;
  startGateMedia: (options: {
    url: string;
    token: string;
    voiceSessionId: string;
  }) => Promise<boolean>;
  /**
   * Proves an opened socket is really the Gate again, by waiting for its first
   * frame. The boolean only says the socket was handed to the network stack, so
   * an attempt that "succeeded" on it spent the whole window proving nothing and
   * returned with a link no one was on. Omitted only where a caller cannot
   * observe frames at all.
   */
  proveLink?: (budgetMs: number) => Promise<GateLinkProof>;
  /** How long one re-opened link may take to speak before it counts as failed. */
  linkReadyMs?: number;
  /** True the moment the call is ending by any other path; attempts stop. */
  isAborted: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  mediaUrl?: (base: string, path: string) => string;
  windowMs?: number;
  log?: (line: string) => void;
};

/**
 * Re-open the media socket for a live call's grant. Resolves true when the
 * Gate was proved to be back on it — its own first frame, not the boolean that
 * opened the socket; false when the window ran out or the call ended first.
 * Never throws: a failed call reports false so the caller can end the call with
 * the reason it really was.
 */
export async function reconnectGateMedia(input: ReconnectGateMediaInput): Promise<boolean> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? (() => Date.now());
  const toMediaUrl = input.mediaUrl ?? mediaSocketUrl;
  const log = input.log ?? (() => undefined);
  const linkReadyMs = input.linkReadyMs ?? GATE_LINK_READY_MS;
  const deadline = now() + (input.windowMs ?? GATE_RECONNECT_WINDOW_MS);
  const delays = gateReconnectDelays(input.windowMs ?? GATE_RECONNECT_WINDOW_MS);

  for (const delay of delays) {
    await sleep(delay);
    // Teardown at any point wins. So does a window with no room left for a
    // round trip: an attempt that cannot finish before the Gate stops holding
    // the call is one more refusal, not a re-attach. An attempt that already
    // started inside the window is always run to its answer. A proven link waits
    // for the Gate's first frame, so its round trip includes that wait — and it
    // is shortened to whatever the window has left rather than allowed to run
    // past the point of no return.
    const room = deadline - now() - ATTEMPT_ROUND_TRIP_MS;
    if (input.isAborted() || room <= 0) return false;
    const proofBudget = input.proveLink ? Math.min(linkReadyMs, room) : 0;
    try {
      const started = await input.startGateMedia({
        url: toMediaUrl(input.gatewayUrl, input.grant.streamPath),
        token: input.gatewayToken,
        voiceSessionId: input.grant.voiceSessionId,
      });
      if (started) {
        const spoken = input.proveLink
          ? await input.proveLink(proofBudget)
          : ('frame' as GateLinkProof);
        if (spoken === 'frame') {
          log(`gate media reconnected session=${input.grant.voiceSessionId}`);
          return true;
        }
        // An opened socket that never spoke is the failure this whole loop exists
        // for: it would otherwise read as a re-attach and spend the rest of the
        // window asleep.
        log(`gate media reconnect unproven session=${input.grant.voiceSessionId} reason=${spoken}`);
      } else {
        log(`gate media reconnect refused session=${input.grant.voiceSessionId}`);
      }
    } catch {
      log(`gate media reconnect attempt failed session=${input.grant.voiceSessionId}`);
    }
  }
  return false;
}
