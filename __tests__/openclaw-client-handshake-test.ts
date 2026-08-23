import { OpenClawGatewayClient } from '@/lib/gateway/openclaw-client';
import type { GatewayProfile } from '@/lib/gateway/types';

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

import {
  loadDeviceAuthToken,
  saveDeviceAuthToken,
} from '@/lib/gateway/device-auth-token';
import { signDevicePayload } from '@/lib/gateway/device-identity';

const mockLoadToken = loadDeviceAuthToken as jest.Mock;
const mockSign = signDevicePayload as jest.Mock;
const mockSaveToken = saveDeviceAuthToken as jest.Mock;

/**
 * The client only ever touches three members of a WebSocket — onopen,
 * onmessage, onclose — plus send/close. A fake keeps the handshake
 * deterministic and lets tests decide exactly when the server speaks.
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

  serverClose(code = 1006, reason = '') {
    this.onclose?.({ code, reason });
  }

  sentFrames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

const PROFILE: GatewayProfile = {
  id: 'gw1',
  name: 'OpenClaw gate',
  url: 'ws://gate.test:8642/openclaw',
  kind: 'openclaw',
  bootstrapToken: 'bootstrap-secret',
  createdAt: 0,
};

function challenge(nonce: string) {
  return { type: 'event', event: 'connect.challenge', payload: { nonce } };
}

/** Drain pending microtasks so an async sendConnect reaches its next await. */
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('OpenClawGatewayClient handshake', () => {
  const realWebSocket = globalThis.WebSocket;
  let client: OpenClawGatewayClient;

  beforeEach(() => {
    jest.useFakeTimers();
    FakeWebSocket.instances = [];
    mockLoadToken.mockReset().mockResolvedValue(null);
    mockSign.mockReset().mockResolvedValue('signature');
    mockSaveToken.mockClear();
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    client = new OpenClawGatewayClient(PROFILE, {});
  });

  afterEach(() => {
    client.disconnect();
    jest.useRealTimers();
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  });

  // The regression: connectSent was claimed before the identity/token awaits,
  // so one rejected read left the flag true with no frame on the wire. Every
  // later challenge was dropped and the session hung in "connecting".
  test('a rejected token read releases the handshake so the next challenge answers', async () => {
    mockLoadToken.mockRejectedValueOnce(new Error('secure store locked'));
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();

    ws.serverFrame(challenge('n1'));
    await flush();

    expect(ws.sent).toHaveLength(0); // nothing was sent — no connect exists
    expect(client.statusDetail).toContain('secure store locked');

    ws.serverFrame(challenge('n2'));
    await flush();

    const frames = ws.sentFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: 'connect', method: 'connect' });
    const params = frames[0].params as { device: { nonce: string } };
    expect(params.device.nonce).toBe('n2');
  });

  test('challenges arriving while the handshake is building do not double-send', async () => {
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverFrame(challenge('n1'));
    ws.serverFrame(challenge('n2'));
    await flush();

    const frames = ws.sentFrames();
    expect(frames).toHaveLength(1);
    const params = frames[0].params as { device: { nonce: string } };
    expect(params.device.nonce).toBe('n1');
  });

  test('a gateway that never challenges still times out instead of hanging in connecting', () => {
    const errors: string[] = [];
    const c = new OpenClawGatewayClient(PROFILE, { onError: (m) => errors.push(m) });
    c.connect();
    FakeWebSocket.instances[0].serverOpen();

    jest.advanceTimersByTime(12_000);

    expect(c.connectionStatus).toBe('disconnected');
    expect(errors.join('\n')).toMatch(/handshake timed out/i);
    c.disconnect();
  });

  test('a sent connect is not killed by the handshake timeout while awaiting the reply', async () => {
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverFrame(challenge('n1'));
    await flush();
    expect(ws.sentFrames()).toHaveLength(1);

    jest.advanceTimersByTime(12_000);

    expect(client.connectionStatus).toBe('connecting'); // the timer saw the honest flag
  });

  test('a socket lost while signing does not send the connect into the void', async () => {
    let releaseSign!: (signature: string) => void;
    mockSign.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseSign = resolve;
        }),
    );
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverFrame(challenge('n1'));
    await flush(); // identity + token read done; parked on the signature

    ws.serverClose(1006);
    expect(client.connectionStatus).toBe('reconnecting');

    releaseSign('signature');
    await flush();

    expect(ws.sent).toHaveLength(0); // never send onto a buried socket

    jest.advanceTimersByTime(1000); // reconnect backoff fires
    expect(FakeWebSocket.instances.length).toBe(2); // a fresh socket took over
  });

  test('the answered challenge carries the signed v4 connect frame', async () => {
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverFrame(challenge('nonce-9'));
    await flush();

    const frames = ws.sentFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'req', id: 'connect', method: 'connect' });
    const params = frames[0].params as {
      minProtocol: number;
      maxProtocol: number;
      role: string;
      auth?: { bootstrapToken?: string };
      device: { id: string; publicKey: string; signature: string; nonce: string };
    };
    expect(params.minProtocol).toBe(4);
    expect(params.maxProtocol).toBe(4);
    expect(params.role).toBe('operator');
    expect(params.auth?.bootstrapToken).toBe('bootstrap-secret');
    expect(params.device.id).toBe('device-1');
    expect(params.device.publicKey).toBe('public-key');
    expect(params.device.signature).toBe('signature');
    expect(params.device.nonce).toBe('nonce-9');
  });

  test('hello-ok stores the issued device token and reports connected', async () => {
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverFrame(challenge('n1'));
    await flush();
    ws.serverFrame({
      type: 'res',
      id: 'connect',
      ok: true,
      payload: {
        type: 'hello-ok',
        protocol: 4,
        server: {},
        auth: { deviceToken: 'dt-1', role: 'operator', scopes: ['operator.read'] },
      },
    });
    await flush();

    expect(client.connectionStatus).toBe('connected');
    expect(mockSaveToken).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'device-1', token: 'dt-1' }),
    );
  });
});
