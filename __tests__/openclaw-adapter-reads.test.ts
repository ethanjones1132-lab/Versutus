// A read that fails and a read that finds nothing are different facts. This
// dialect answered `[]` for both, and `resolveResumeSession` only declines to
// open a session when the list THROWS — the invariant its own comment states —
// so a timed-out `sessions.list` read as "the gateway hosts no sessions" and
// every failure opened a brand-new thread on a gateway that still had the old
// one. The same shape folded a failed history read into a successfully empty
// transcript.

// The adapter remembers the sessions it owns through key-value storage, and
// key-value pulls in AsyncStorage's native module.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

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

import { OpenClawGatewayClient } from '@/lib/gateway/openclaw-client';
import { resolveResumeSession } from '@/lib/gateway/session-resume';
import { OpenClawAdapterClient } from '@/lib/portal/openclaw-adapter';
import type { GatewayProfile } from '@/lib/gateway/types';

const PROFILE: GatewayProfile = {
  id: 'gw1',
  name: 'OpenClaw gate',
  url: 'ws://gate.test:8642/openclaw',
  kind: 'openclaw',
  bootstrapToken: 'bootstrap-secret',
  createdAt: 0,
};

const creates = (request: jest.SpyInstance) =>
  request.mock.calls.filter(([method]) => method === 'sessions.create');

describe('OpenClawAdapterClient — a failed read is an error, not an empty list', () => {
  let request: jest.SpyInstance;

  beforeEach(() => {
    request = jest.spyOn(OpenClawGatewayClient.prototype, 'request');
  });

  afterEach(() => {
    request.mockRestore();
  });

  test('a refused sessions.list rejects', async () => {
    request.mockRejectedValue(new Error('Request timed out: sessions.list'));
    const adapter = new OpenClawAdapterClient(PROFILE, {});

    await expect(adapter.getSessions()).rejects.toThrow('Request timed out: sessions.list');
    adapter.disconnect();
  });

  test('a failed list leaves the thread sessionless instead of opening another', async () => {
    // The exact failure: the swallowed timeout used to fall through to
    // createSession, and the gateway collected one empty session per failure
    // while the assistant lost the thread.
    request.mockRejectedValue(new Error('Request timed out: sessions.list'));
    const adapter = new OpenClawAdapterClient(PROFILE, {});

    const outcome = await resolveResumeSession(adapter);

    expect(outcome.sessionId).toBeUndefined();
    expect(outcome.sessions).toEqual([]);
    expect(creates(request)).toHaveLength(0);
    adapter.disconnect();
  });

  test('a failed history read rejects rather than folding in as an empty transcript', async () => {
    request.mockRejectedValue(new Error('Gateway closed (1006)'));
    const adapter = new OpenClawAdapterClient(PROFILE, {});

    await expect(adapter.getSessionMessages('oc_1')).rejects.toThrow('Gateway closed (1006)');
    adapter.disconnect();
  });

  test('a failed model catalogue rejects too', async () => {
    request.mockRejectedValue(new Error('Request timed out: models.list'));
    const adapter = new OpenClawAdapterClient(PROFILE, {});

    await expect(adapter.getModels()).rejects.toThrow('Request timed out: models.list');
    adapter.disconnect();
  });

  test('an empty but successful read is still an empty list', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') return { sessions: [] };
      if (method === 'session.messages') return { messages: [] };
      if (method === 'models.list') return { models: [] };
      return null;
    });
    const adapter = new OpenClawAdapterClient(PROFILE, {});

    await expect(adapter.getSessions()).resolves.toEqual([]);
    await expect(adapter.getSessionMessages('oc_1')).resolves.toEqual([]);
    await expect(adapter.getModels()).resolves.toEqual([]);
    adapter.disconnect();
  });
});