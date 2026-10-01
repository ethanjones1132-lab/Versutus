// ─── An unreachable gateway is not a refusal ────────────────────────────────
// requestGatewayAccess reported one thing for everything: "the gateway denied
// you". A PC asleep, a tailnet down and a closed port are transport facts, not
// a verdict — the operator was sent hunting for a credential problem they did
// not have. The OpenClaw client's onError carries both (it also fires "Could not
// reach gateway at …") and the signed POST's catch-all swallowed every failure
// the same way, so neither path could tell a refusal from a dead path. Only a
// refusal the gateway itself can be shown to have made stays `denied`.

jest.mock('@/lib/gateway/device-auth-token', () => ({
  loadDeviceAuthToken: jest.fn(),
  saveDeviceAuthToken: jest.fn(() => Promise.resolve()),
  clearDeviceAuthToken: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/gateway/device-identity', () => ({
  loadOrCreateDeviceIdentity: jest.fn(() =>
    Promise.resolve({
      deviceId: 'device-1',
      publicKeyB64Url: 'public-key',
      privateKeyB64Url: 'private-key',
      createdAtMs: 0,
    }),
  ),
  signDevicePayload: jest.fn(() => Promise.resolve('signature')),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { gatewayHosts: ['100.64.0.9'] } } },
}));

import { loadDeviceAuthToken } from '@/lib/gateway/device-auth-token';
import { requestGatewayAccess } from '@/lib/portal/access';
import type { GatewayIdentity } from '@/lib/portal/identify';

const mockLoadToken = loadDeviceAuthToken as jest.Mock;

/**
 * The client only ever touches onopen/onmessage/onclose plus send/close, so a
 * fake keeps the handshake deterministic and lets each test say exactly when
 * (and whether) the gateway speaks.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  closedByClient = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closedByClient = true;
  }

  serverOpen() {
    this.onopen?.();
  }

  serverFrame(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** A dial that died before it ever opened — a dead host, or a dead name. */
  serverClose(code = 1006, reason = '') {
    this.onclose?.({ code, reason });
  }
}

const BASE_URL = 'http://gate.tailnet.ts.net:8642';
const WS_URL = 'ws://gate.tailnet.ts.net:8642/openclaw';

function openclawIdentity(): GatewayIdentity {
  return {
    kind: 'openclaw',
    kindLabel: 'OpenClaw',
    auth: { schemes: ['challenge-response'], requiresToken: false, grantPath: undefined },
    transportHint: 'ws',
    source: 'probe-openclaw',
    identifiedAt: Date.now(),
  };
}

/** Drain pending microtasks so an async sendConnect reaches its next await. */
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

function challenge(nonce: string) {
  return { type: 'event', event: 'connect.challenge', payload: { nonce } };
}

function helloOk() {
  return {
    type: 'res',
    id: 'connect',
    ok: true,
    payload: {
      type: 'hello-ok',
      protocol: 4,
      server: {},
      auth: { deviceToken: 'dt-1', role: 'operator', scopes: ['operator.read'] },
    },
  };
}

describe('an OpenClaw gateway that cannot be reached is reported as unreachable', () => {
  const realWebSocket = globalThis.WebSocket;
  // Pinned so a scheduled retry rung's delay is exactly its base — the timing
  // advances below read deterministically.
  let randomSpy: jest.SpyInstance<number>;

  beforeEach(() => {
    jest.useFakeTimers();
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    FakeWebSocket.instances = [];
    mockLoadToken.mockReset().mockResolvedValue(null);
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    randomSpy.mockRestore();
    jest.useRealTimers();
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  });

  test('a dial that dies before any frame is unreachable, not a denial', async () => {
    const pending = requestGatewayAccess({ baseUrl: BASE_URL, identity: openclawIdentity() });

    expect(FakeWebSocket.instances[0].url).toBe(WS_URL);
    FakeWebSocket.instances[0].serverClose(1006);

    const result = await pending;
    expect(result.status).toBe('unreachable');
    expect((result as { reason: string }).reason).toMatch(/could not reach gateway/i);
  });

  test('a socket closed before the handshake completed is unreachable', async () => {
    const pending = requestGatewayAccess({ baseUrl: BASE_URL, identity: openclawIdentity() });

    FakeWebSocket.instances[0].serverOpen();
    FakeWebSocket.instances[0].serverClose(1005);

    const result = await pending;
    expect(result.status).toBe('unreachable');
    expect((result as { reason: string }).reason).toMatch(/before handshake/i);
  });

  test('a gateway that never answers is unreachable, not denied', async () => {
    const pending = requestGatewayAccess({ baseUrl: BASE_URL, identity: openclawIdentity() });

    jest.advanceTimersByTime(15_000);

    const result = await pending;
    expect(result).toEqual({
      status: 'unreachable',
      reason: 'OpenClaw gateway did not answer the access request in time.',
    });
  });

  test('a refused credential after a completed handshake stays a denial', async () => {
    const pending = requestGatewayAccess({ baseUrl: BASE_URL, identity: openclawIdentity() });
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverFrame(challenge('n1'));
    await flush();

    ws.serverFrame({
      type: 'res',
      id: 'connect',
      ok: false,
      error: { code: 'AUTH_TOKEN_MISSING', message: 'no token configured' },
    });

    const result = await pending;
    expect(result).toEqual({
      status: 'denied',
      reason: 'Gateway requires setup token or pairing approval',
    });
  });

  test('a connect error the client does not flag as a refusal stays on the conservative side', async () => {
    // The client flags one verdict on this channel — a rejected credential.
    // Any other connect error frame reaches onError unflagged, so the honest
    // reading is "no refusal we can point at"; the gateway's own wording is
    // still the reason text either way.
    const pending = requestGatewayAccess({ baseUrl: BASE_URL, identity: openclawIdentity() });
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverFrame(challenge('n1'));
    await flush();

    ws.serverFrame({
      type: 'res',
      id: 'connect',
      ok: false,
      error: { code: 'PROTOCOL_VERSION_UNSUPPORTED', message: 'wire protocol 4 is required' },
    });

    const result = await pending;
    expect(result).toEqual({ status: 'unreachable', reason: 'wire protocol 4 is required' });
  });

  test('pairing required is still pending approval', async () => {    const pending = requestGatewayAccess({ baseUrl: BASE_URL, identity: openclawIdentity() });
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverFrame(challenge('n1'));
    await flush();

    ws.serverFrame({
      type: 'res',
      id: 'connect',
      ok: false,
      error: { code: 'PAIRING_REQUIRED', message: 'Approval required', details: { requestId: 'req-77' } },
    });

    const result = await pending;
    expect(result.status).toBe('pending-approval');
    expect((result as { requestId?: string }).requestId).toBe('req-77');
  });

  test('an accepted handshake is still granted', async () => {
    const pending = requestGatewayAccess({ baseUrl: BASE_URL, identity: openclawIdentity() });
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverFrame(challenge('n1'));
    await flush();

    ws.serverFrame(helloOk());

    const result = await pending;
    expect(result).toEqual({
      status: 'granted',
      token: 'dt-1',
      role: 'operator',
      scopes: ['operator.read'],
    });
  });
});
