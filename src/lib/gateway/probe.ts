export type ProbeResult =
  | { ok: true; url: string; latencyMs: number }
  | { ok: false; url: string; error: string; code?: 'timeout' | 'connect-failed' | 'closed' | 'unreachable' };

/**
 * Probe a Hermes gateway by hitting the /health endpoint.
 * Hermes uses HTTP (not WebSocket), default port 8642.
 */
export async function probeGatewayUrl(url: string, timeoutMs = 7000): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { ok: false, url, error: 'Timed out waiting for gateway', code: 'timeout' };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      url,
      error: message,
      code: message.includes('connect') || message.includes('Network') ? 'connect-failed' : 'unreachable',
    };
  }
}

export async function probeGatewayCandidates(
  urls: string[],
  onProgress?: (message: string) => void,
  timeoutMs = 7000,
): Promise<ProbeResult | null> {
  for (const url of urls) {
    onProgress?.(describeProbeTarget(url));
    const result = await probeGatewayUrl(url, timeoutMs);
    if (result.ok) return result;
  }
  return null;
}

/**
 * Probe a small number of high-priority URLs in parallel.
 */
export async function probeHighPriorityCandidates(
  urls: string[],
  onProgress?: (message: string) => void,
  timeoutMs = 3500,
): Promise<ProbeResult | null> {
  if (urls.length === 0) return null;

  const top = urls.slice(0, 4);

  const results = await Promise.allSettled(
    top.map(async (url) => {
      onProgress?.(describeProbeTarget(url));
      const res = await probeGatewayUrl(url, timeoutMs);
      return { url, res };
    }),
  );

  const successes: ProbeResult[] = [];
  for (const settled of results) {
    if (settled.status === 'fulfilled' && settled.value.res.ok) {
      successes.push(settled.value.res);
    }
  }
  if (successes.length === 0) return null;

  // Prefer a gate that advertises the Open Gateway Manifest (Versutus Gate)
  // over a bare Hermes /health on :8642 when both answer.
  for (const success of successes) {
    if (await hasGatewayManifest(success.url, timeoutMs)) return success;
  }
  return successes[0];
}

async function hasGatewayManifest(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(2000, timeoutMs));
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/.well-known/gateway.json`, {
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