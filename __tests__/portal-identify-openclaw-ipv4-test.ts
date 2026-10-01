// ─── The OpenClaw fingerprint gets the tailnet-IPv4 fallback too ────────────
// identifyGateway wrapped the manifest, Hermes and HTTP-alive reads in
// withHostLookupRetry, so a MagicDNS miss moved them onto the advertised
// tailnet IPv4. The OpenClaw WS probe did not: it dialled the hostname alone,
// so a WS-only gateway whose name missed while its advertised address worked
// was classified `unknown` — and the app then built a Hermes HTTP client for a
// gateway it can only reach over WebSocket. The probe now rides the same seam
// as the HTTP fingerprints, with its own per-attempt budget still drawn from
// what is left of the identify timeout.

import { resetHostLookupMemoryForTests } from '@/lib/gateway/host-lookup';
import { identifyGateway } from '@/lib/portal/identify';

const HOSTNAME = 'gate.tailnet.ts.net';
const IPV4 = '100.64.0.9';
const BASE_URL = `http://${HOSTNAME}:8642`;
const WS_HOSTNAME = `ws://${HOSTNAME}:8642/openclaw`;
const WS_IPV4 = `ws://${IPV4}:8642/openclaw`;

function lookupMiss(): Error {
  return new TypeError('fetch failed', {
    cause: { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: HOSTNAME },
  });
}

function noManifestResponse(): Response {
  return {
    ok: false,
    status: 404,
    text: () => Promise.resolve('{}'),
  } as unknown as Response;
}

const CHALLENGE = JSON.stringify({
  type: 'event',
  event: 'connect.challenge',
  payload: { nonce: 'n1' },
});

/**
 * A socket that answers only on the hosts a test declares, and fails the dial
 * everywhere else. Real WebSockets report the outcome a tick after they are
 * constructed — the probe only starts listening once the constructor returns.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static answeringHosts = new Set<string>();
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    setTimeout(() => this.deliver(), 0);
  }

  private deliver() {
    if (FakeWebSocket.answeringHosts.has(new URL(this.url).hostname)) {
      this.onopen?.();
      this.onmessage?.({ data: CHALLENGE });
      return;
    }
    // A name that does not resolve fails the dial: React Native raises onerror
    // (OkHttp's onFailure) and the socket closes abnormal.
    this.onerror?.();
    this.onclose?.({ code: 1006, reason: '' });
  }

  send() {}

  close() {}
}

const realFetch = globalThis.fetch;
const realWebSocket: unknown = globalThis.WebSocket;

beforeEach(() => {
  resetHostLookupMemoryForTests();
  FakeWebSocket.instances = [];
  FakeWebSocket.answeringHosts = new Set();
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
});

afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
  resetHostLookupMemoryForTests();
});

describe('the OpenClaw WS probe retries a MagicDNS miss over the tailnet IPv4s', () => {
  test('a gateway only reachable on its advertised IPv4 identifies as openclaw', async () => {
    FakeWebSocket.answeringHosts.add(IPV4);
    const fetched: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      fetched.push(url);
      if (url.startsWith(`http://${HOSTNAME}`)) throw lookupMiss();
      // The IPv4 answers HTTP but serves neither a manifest nor a Hermes
      // fingerprint — the WS probe is the only thing left that can identify it.
      return Promise.resolve(noManifestResponse());
    });

    const identity = await identifyGateway({ baseUrl: BASE_URL, alternateIpv4: [IPV4] });

    expect(identity.kind).toBe('openclaw');
    expect(identity.source).toBe('probe-openclaw');
    expect(identity.transportHint).toBe('ws');
    expect(FakeWebSocket.instances.map((ws) => ws.url)).toContain(WS_IPV4);
    expect(fetched.join()).not.toContain(IPV4 + '/health'); // no Hermes read proved it
  });

  test('no advertised address leaves the cascade on the hostname and still reads unknown', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() => {
      throw lookupMiss();
    });

    const identity = await identifyGateway({ baseUrl: BASE_URL });

    expect(identity.kind).toBe('unknown');
    expect(identity.source).toBe('unknown');
    expect(FakeWebSocket.instances.map((ws) => ws.url)).not.toContain(WS_IPV4);
  });

  test('a hostname that answers the challenge is never dialled on the IPv4', async () => {
    FakeWebSocket.answeringHosts.add(HOSTNAME);
    (globalThis as { fetch: unknown }).fetch = jest.fn(() => Promise.resolve(noManifestResponse()));

    const identity = await identifyGateway({ baseUrl: BASE_URL, alternateIpv4: [IPV4] });

    expect(identity.kind).toBe('openclaw');
    expect(FakeWebSocket.instances.map((ws) => ws.url)).toEqual([WS_HOSTNAME]);
  });

  test('a gateway that fails on every address resolves to an honest unknown identity', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() => {
      throw lookupMiss();
    });

    const identity = await identifyGateway({ baseUrl: BASE_URL, alternateIpv4: [IPV4] });

    expect(identity.kind).toBe('unknown');
    expect(identity.transportHint).toBeUndefined();
    expect(FakeWebSocket.instances.map((ws) => ws.url)).toContain(WS_HOSTNAME);
  });

  test('an https base keeps its wss probe on the hostname', async () => {
    FakeWebSocket.answeringHosts.add(HOSTNAME);
    (globalThis as { fetch: unknown }).fetch = jest.fn(() => {
      throw lookupMiss();
    });

    const identity = await identifyGateway({ baseUrl: 'https://gate.tailnet.ts.net', alternateIpv4: [IPV4] });

    expect(identity.kind).toBe('openclaw');
    expect(FakeWebSocket.instances.map((ws) => ws.url)).toEqual(['wss://gate.tailnet.ts.net/openclaw']);
  });
});
