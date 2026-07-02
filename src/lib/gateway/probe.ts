export type ProbeResult =
  | { ok: true; url: string; latencyMs: number }
  | { ok: false; url: string; error: string; code?: 'timeout' | 'connect-failed' | 'closed' | 'unreachable' };

export async function probeGatewayUrl(url: string, timeoutMs = 7000): Promise<ProbeResult> {
  const started = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let socket: WebSocket | null = null;

    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, url, error: 'Timed out waiting for gateway', code: 'timeout' });
    }, timeoutMs);

    try {
      socket = new WebSocket(url);
    } catch (error) {
      finish({
        ok: false,
        url,
        error: error instanceof Error ? error.message : String(error),
        code: 'connect-failed',
      });
      return;
    }

    socket.onopen = () => {
      finish({ ok: true, url, latencyMs: Date.now() - started });
    };

    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as {
          type?: string;
          event?: string;
        };
        if (frame.type === 'event' && frame.event === 'connect.challenge') {
          finish({ ok: true, url, latencyMs: Date.now() - started });
        }
      } catch {
        // ignore malformed frames
      }
    };

    socket.onerror = () => {
      finish({ ok: false, url, error: 'Could not open connection to gateway', code: 'connect-failed' });
    };

    socket.onclose = () => {
      if (!settled) {
        finish({ ok: false, url, error: 'Connection closed before handshake', code: 'closed' });
      }
    };
  });
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
 * Probe a small number of high-priority URLs in parallel (limited concurrency).
 * Returns the first successful result, or null if none succeed quickly.
 * Used to speed up automatic detection without hammering many candidates.
 */
export async function probeHighPriorityCandidates(
  urls: string[],
  onProgress?: (message: string) => void,
  timeoutMs = 3500,
): Promise<ProbeResult | null> {
  if (urls.length === 0) return null;

  const top = urls.slice(0, 3); // limited parallel for UX speed

  const results = await Promise.allSettled(
    top.map(async (url) => {
      onProgress?.(describeProbeTarget(url));
      const res = await probeGatewayUrl(url, timeoutMs);
      return { url, res };
    })
  );

  for (const settled of results) {
    if (settled.status === 'fulfilled' && settled.value.res.ok) {
      return settled.value.res;
    }
  }

  return null;
}

function describeProbeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = parsed.port || (parsed.protocol === 'wss:' ? '443' : '18789');
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
