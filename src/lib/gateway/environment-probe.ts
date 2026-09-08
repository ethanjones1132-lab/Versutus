// ─── Probe the active CLI environment so its card reads "ready" ───────────
//
// The Gate boots every enabled environment as `stopped` until something
// probes it. `environments.lifecycle.start` IS that probe (supervisor.start
// === check). Chat never needed it — sessions create fine against a stopped
// environment — so this is best-effort: a failure is named, never thrown,
// and must not delay or fail the connection.
//
// The provider used to fire this only on first adoption of a default
// backend. Once `selectedBackendId` was set, every later connect
// early-returned and the cards stayed "stopped". A backend becoming
// active — first adoption, reconnect after the manifest re-lands, or an
// explicit switch — is the moment to probe, and only that once.

/** The RPC used to probe an environment. */
export type EnvironmentProbeRequest = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/** A probe either flipped the environment to ready, or it named why not. */
export type EnvironmentProbeResult = { ok: true } | { ok: false; error: string };

/**
 * Whether this render is a backend becoming active, and therefore worth
 * probing. `lastProbedId` is the id already probed for this activation;
 * clearing it when backends disappear is how a reconnect re-probes the
 * same backend without looping on every render.
 *
 * A selected backend is not probed until the gateway is connected —
 * `environments.lifecycle.start` throws "Gateway not connected" before
 * then, and that is not a real environment fault.
 */
export function decideEnvironmentProbe(input: {
  backendId: string | undefined;
  lastProbedId: string | undefined;
  backendsAvailable: boolean;
  connected: boolean;
}): { probeId?: string; lastProbedId: string | undefined } {
  if (!input.backendsAvailable) {
    return { lastProbedId: undefined };
  }
  if (!input.backendId || input.backendId === input.lastProbedId) {
    return { lastProbedId: input.lastProbedId };
  }
  if (!input.connected) {
    // Became active, but wait until connected to fire. Do not mark probed.
    return { lastProbedId: input.lastProbedId };
  }
  return { probeId: input.backendId, lastProbedId: input.backendId };
}

/**
 * The failure copy for a rejected probe. Deliberately the slash path's own
 * wording (`Environment ${id} could not be started: …`) so the background
 * probe and `/env start` name the same failure the same way.
 */
export function environmentProbeFailureText(id: string, error: string): string {
  return `Environment ${id} could not be started: ${error}`;
}

/**
 * Probe `environments.lifecycle.start`. A resolved call means the card
 * can read "ready"; a rejection is returned as a result so the caller
 * can name it without the connect path seeing a throw.
 */
export async function probeEnvironmentLifecycle(
  request: EnvironmentProbeRequest,
  id: string,
): Promise<EnvironmentProbeResult> {
  try {
    await request('environments.lifecycle.start', { id });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
