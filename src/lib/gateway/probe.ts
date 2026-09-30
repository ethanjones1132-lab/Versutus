import { PROBE_WAVE_CONCURRENCY, runCapped } from '@/lib/gateway/reachability-wave';

export type ProbeResult =
  | { ok: true; url: string; latencyMs: number; hasManifest?: boolean }
  | { ok: false; url: string; error: string; code?: 'timeout' | 'connect-failed' | 'closed' | 'unreachable' };

/**
 * Phone → PC over a Tailscale DERP relay was measured at 0.9–1.7s RTT
 * with dropped pings. The 3-way handshake alone can exceed a 3.5s budget;
 * aborted fetches then show up on the PC as TIME_WAIT / SynReceived.
 */
export const GATEWAY_PROBE_TIMEOUT_MS = 12_000;
export const GATEWAY_PROBE_PARALLEL_TIMEOUT_MS = 10_000;
export const GATEWAY_MANIFEST_PROBE_TIMEOUT_MS = 8_000;

/**
 * When a lower-priority candidate answers first, how long to keep waiting for
 * a higher-priority one to settle before taking the best success on hand.
 */
export const PROBE_PRIORITY_GRACE_MS = 400;

/**
 * Probe a Hermes gateway by hitting the /health endpoint.
 * Hermes uses HTTP (not WebSocket), default port 8642.
 *
 * `signal` lets a caller abort an unsettled probe (a higher-priority candidate
 * already won the wave); the probe then reports `closed`, not `timeout`.
 */
export async function probeGatewayUrl(
  url: string,
  timeoutMs = GATEWAY_PROBE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    // Normalize URL to HTTP
    const baseUrl = url
      .replace(/^wss:\/\//i, 'https://')
      .replace(/^ws:\/\//i, 'http://')
      .replace(/\/+$/, '');
    const healthUrl = `${baseUrl}/health`;

    const response = await fetch(healthUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    // Only the status was needed: release the body so the connection does not
    // stay open until GC — on success and on refusal alike.
    try {
      const releasing = response.body?.cancel() as Promise<void> | undefined;
      releasing?.catch?.(() => undefined);
    } catch {
      // cancel threw synchronously; there is nothing left to release.
    }
    if (response.ok) {
      return { ok: true, url: baseUrl, latencyMs: Date.now() - started };
    }
    return {
      ok: false,
      url: baseUrl,
      error: `Gateway returned HTTP ${response.status}`,
      code: 'connect-failed',
    };
  } catch (error) {
    clearTimeout(timer);
    // A caller abort means the wave already moved on, not a timeout.
    if (signal?.aborted) {
      return { ok: false, url, error: 'Probe cancelled', code: 'closed' };
    }
    // The timer is the only thing that aborts this probe; Expo's native fetch
    // rejects a cancelled request as a plain FetchError, never an AbortError.
    if (controller.signal.aborted) {
      return { ok: false, url, error: 'Timed out waiting for gateway', code: 'timeout' };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      url,
      error: message,
      code: message.includes('connect') || message.includes('Network') ? 'connect-failed' : 'unreachable',
    };
  } finally {
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

export async function probeGatewayCandidates(
  urls: string[],
  onProgress?: (message: string) => void,
  timeoutMs = GATEWAY_PROBE_TIMEOUT_MS,
): Promise<ProbeResult | null> {
  if (urls.length === 0) return null;
  // Every candidate is attempted, so every candidate is announced up front in
  // listed order. The pool below probes them concurrently; results keep input
  // order, so the earliest-listed healthy candidate still wins.
  for (const url of urls) {
    onProgress?.(describeProbeTarget(url));
  }
  const results = await runCapped(urls, PROBE_WAVE_CONCURRENCY, (url) =>
    probeGatewayUrl(url, timeoutMs),
  );
  for (const result of results) {
    if (result.ok) return result;
  }
  return null;
}

/**
 * Probe a small number of high-priority URLs in parallel.
 *
 * Only the head of the list is probed — the cold-start fallback relies on
 * HIGH_PRIORITY_WAVE_SIZE to know exactly which URLs a wave already tried.
 */
export const HIGH_PRIORITY_WAVE_SIZE = 4;

export async function probeHighPriorityCandidates(
  urls: string[],
  onProgress?: (message: string) => void,
  timeoutMs = GATEWAY_PROBE_PARALLEL_TIMEOUT_MS,
): Promise<ProbeResult | null> {
  if (urls.length === 0) return null;

  const top = urls.slice(0, HIGH_PRIORITY_WAVE_SIZE);
  const controllers = top.map(() => new AbortController());

  return new Promise<ProbeResult | null>((resolve) => {
    const results: (ProbeResult | undefined)[] = top.map(() => undefined);
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      // Unsettled probes must not be left running: abort them.
      for (let i = 0; i < top.length; i += 1) {
        if (results[i] === undefined) controllers[i].abort();
      }
      void preferManifest(results, timeoutMs).then(resolve).catch(() => {
        // A throw in the manifest checks must neither leave the promise
        // pending nor raise an unhandled rejection: fall back to the best
        // success on hand.
        resolve(results.find((r) => r?.ok === true) ?? null);
      });
    };

    // Resolve as soon as a success arrives for the highest-priority candidate
    // still in the running (no higher-priority candidate pending). If a
    // lower-priority one succeeds first, wait at most a short grace for the
    // higher-priority ones to settle, then take the best success.
    const evaluate = () => {
      for (let i = 0; i < top.length; i += 1) {
        if (results[i]?.ok && results.slice(0, i).every((r) => r !== undefined)) {
          finish();
          return;
        }
      }
      if (results.every((r) => r !== undefined)) {
        finish();
        return;
      }
      if (results.some((r) => r?.ok) && graceTimer === undefined) {
        graceTimer = setTimeout(() => {
          graceTimer = undefined;
          finish();
        }, PROBE_PRIORITY_GRACE_MS);
      }
    };

    top.forEach((url, index) => {
      onProgress?.(describeProbeTarget(url));
      probeGatewayUrl(url, timeoutMs, controllers[index].signal).then(
        (result) => {
          results[index] = result;
          evaluate();
        },
        () => {
          results[index] = { ok: false, url, error: 'Probe failed', code: 'unreachable' };
          evaluate();
        },
      );
    });
  });
}

/**
 * Prefer a gate that advertises the Open Gateway Manifest (Versutus Gate) over
 * a bare Hermes /health on :8642 when both answer. The manifest check runs on
 * the chosen (highest-priority) success first; only when it lacks a manifest
 * do the remaining successes get checked, and then all at once, so a fallback
 * wave costs one manifest budget rather than one per success. The flag travels
 * with the result — the connect path hands it to identifyGateway as
 * skipManifest instead of replaying the same fetch.
 */
async function preferManifest(
  results: (ProbeResult | undefined)[],
  timeoutMs: number,
): Promise<ProbeResult | null> {
  const successes = () =>
    results.filter((r): r is Extract<ProbeResult, { ok: true }> => r?.ok === true);
  const best = successes()[0];
  if (!best) return null;
  if (await hasGatewayManifest(best.url, timeoutMs)) {
    return { ...best, hasManifest: true };
  }
  // Re-read: more successes may have landed while the chosen's check ran. The
  // remainder is RACED, not queued: a wave that fell back one manifest budget
  // per success would cost the connect path seconds per dead candidate.
  const rest = successes().slice(1);
  if (rest.length > 0) {
    try {
      const winner = await Promise.any(
        rest.map(async (candidate) => {
          if (!(await hasGatewayManifest(candidate.url, timeoutMs))) {
            throw new Error('no manifest');
          }
          return candidate;
        }),
      );
      return { ...winner, hasManifest: true };
    } catch {
      // None of the fallbacks advertises a manifest either.
    }
  }
  return { ...best, hasManifest: false };
}

async function hasGatewayManifest(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(GATEWAY_MANIFEST_PROBE_TIMEOUT_MS, timeoutMs),
  );
  let response: Response | undefined;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/.well-known/gateway.json`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as { manifest?: string } | null;
    return typeof body?.manifest === 'string' && body.manifest.startsWith('versutus-gateway/');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    // Only the status was needed: release the body so the connection does not
    // stay open until GC.
    try {
      const releasing = response?.body?.cancel() as Promise<void> | undefined;
      releasing?.catch?.(() => undefined);
    } catch {
      // cancel threw synchronously; there is nothing left to release.
    }
  }
}

function describeProbeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = parsed.port || '8642';
    if (host.endsWith('.ts.net')) return `Trying ${host} over Tailscale…`;
    if (host.startsWith('100.')) return `Trying ${host} on your tailnet…`;
    if (host === '127.0.0.1' || host === 'localhost') return `Trying local gateway at ${port}…`;
    return `Trying ${host}:${port}…`;
  } catch {
    return 'Searching for your gateway…';
  }
}

export function categorizeProbeError(result: ProbeResult | null): string {
  if (!result || result.ok) return '';
  const err = result.error.toLowerCase();
  if (result.code === 'timeout' || err.includes('time')) {
    return 'Gateway not responding in time. It may be starting up or blocked.';
  }
  if (result.code === 'connect-failed' || err.includes('connect') || err.includes('failed')) {
    return 'Could not reach the gateway host. Check network/Tailscale.';
  }
  if (result.code === 'closed' || err.includes('close')) {
    return 'Connection closed before handshake. Gateway may be restarting.';
  }
  return 'Unable to connect. Verify gateway is running and address is correct.';
}