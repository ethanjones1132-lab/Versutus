// ─── Rejoining a Gate call after the media socket drops ───────────────────
// The Gate holds a detached call open for its resume window (20 s) and
// re-attaches a socket that arrives with the same voiceSessionId. The phone
// used to treat any socket failure as fatal and end the call inside that
// window, so one Wi-Fi blip killed an otherwise healthy call. This is the
// retry half of that contract: retry startGateMedia with the same grant, with
// backoff, for no longer than the Gate will hold the call. Teardown at any
// point wins — the caller's isAborted() is checked before every attempt.

import { mediaSocketUrl } from '@/lib/voice/gate-media-url';
import type { GateVoiceGrant } from '@/lib/voice/handsfree-start-reason';

/**
 * How long the Gate holds a call open after its socket detaches
 * (`RESUME_TIMEOUT_MS` in gate/core/voice/media-socket.mjs). The phone must
 * spend its whole retry budget inside this window or the re-attach 404s.
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
 * Gate accepted the socket again; false when the window ran out or the call
 * ended first. Never throws: a failed call reports false so the caller can
 * fold the original fatal frame.
 */
export async function reconnectGateMedia(input: ReconnectGateMediaInput): Promise<boolean> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? (() => Date.now());
  const toMediaUrl = input.mediaUrl ?? mediaSocketUrl;
  const log = input.log ?? (() => undefined);
  const deadline = now() + (input.windowMs ?? GATE_RECONNECT_WINDOW_MS);
  const delays = gateReconnectDelays(input.windowMs ?? GATE_RECONNECT_WINDOW_MS);

  for (const delay of delays) {
    await sleep(delay);
    // Teardown at any point wins. So does a window with no room left for a
    // round trip: an attempt that cannot finish before the Gate stops holding
    // the call is one more refusal, not a re-attach. An attempt that already
    // started inside the window is always run to its answer.
    if (input.isAborted() || now() + ATTEMPT_ROUND_TRIP_MS >= deadline) return false;
    try {
      const started = await input.startGateMedia({
        url: toMediaUrl(input.gatewayUrl, input.grant.streamPath),
        token: input.gatewayToken,
        voiceSessionId: input.grant.voiceSessionId,
      });
      if (started) {
        log(`gate media reconnected session=${input.grant.voiceSessionId}`);
        return true;
      }
      log(`gate media reconnect refused session=${input.grant.voiceSessionId}`);
    } catch {
      log(`gate media reconnect attempt failed session=${input.grant.voiceSessionId}`);
    }
  }
  return false;
}
