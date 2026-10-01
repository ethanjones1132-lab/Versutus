// The thread has to survive a reconnect on this dialect. Two things stopped it:
// every row `sessions.list` returned was stamped `source: 'openclaw'`, while
// `pickAppSession` only recognises `api_server` — so no session this app owned
// could ever match and every connect listed the catalogue, found nothing and
// opened another; and nothing anywhere remembered which sessions this app had
// opened, so even a correctly tagged row was unrecognisable by the time the
// provider re-attached and built a new adapter.
//
// The adapter now keeps its owned ids in key-value storage, because the profile
// object it is handed cannot carry them: `createClientForKind` passes
// `profileWithAlternateIpv4(gateway)`, a fresh copy, and `updateProfile` is never
// called — so a pin written on the profile is read by nobody in production. These
// tests therefore hand each adapter its OWN copy of the profile, exactly as
// `createClientForKind` does, and share nothing but the fake storage.

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

import AsyncStorage from '@react-native-async-storage/async-storage';
import { OpenClawGatewayClient } from '@/lib/gateway/openclaw-client';
import { resolveResumeSession } from '@/lib/gateway/session-resume';
import { OpenClawAdapterClient, OWNED_SESSIONS_KEY_PREFIX } from '@/lib/portal/openclaw-adapter';
import type { GatewayProfile } from '@/lib/gateway/types';

const profile = (extra: Partial<GatewayProfile> = {}): GatewayProfile => ({
  id: 'gw1',
  name: 'OpenClaw gate',
  url: 'ws://gate.test:8642/openclaw',
  kind: 'openclaw',
  bootstrapToken: 'bootstrap-secret',
  createdAt: 0,
  ...extra,
});

/** A gateway holding one session the app owns and one belonging to the TUI. */
function catalogue(request: jest.SpyInstance, created: Record<string, unknown>[]) {
  request.mockImplementation(async (method: string) => {
    if (method === 'sessions.list') {
      return { sessions: [...created, { id: 'tui-nightly', title: 'nightly sweep' }] };
    }
    if (method === 'sessions.create') {
      created.push({ id: 'oc_1', title: 'scratch' });
      return created[created.length - 1];
    }
    return null;
  });
}

const creates = (request: jest.SpyInstance) =>
  request.mock.calls.filter(([method]) => method === 'sessions.create');

describe('OpenClawAdapterClient — the thread survives a reconnect', () => {
  let request: jest.SpyInstance;

  beforeEach(async () => {
    request = jest.spyOn(OpenClawGatewayClient.prototype, 'request');
    await (AsyncStorage as { clear: () => Promise<void> }).clear();
  });

  afterEach(() => {
    request.mockRestore();
  });

  test('connect → reconnect resolves the same session and creates nothing new', async () => {
    const created: Record<string, unknown>[] = [];
    catalogue(request, created);

    const adapter = new OpenClawAdapterClient(profile(), {});
    const first = await resolveResumeSession(adapter);
    expect(first.sessionId).toBe('oc_1');

    // A socket-level reconnect: same adapter, no new profile.
    adapter.disconnect();
    const second = await resolveResumeSession(adapter);
    expect(second.sessionId).toBe('oc_1');
    expect(creates(request)).toHaveLength(1);
    adapter.disconnect();
  });

  test('an adapter rebuilt on a fresh copy of the profile resumes the same session', async () => {
    // The production shape: `createClientForKind` builds the adapter from a
    // `{...profile}` copy, so nothing on the profile object survives, and each
    // re-attach builds a brand-new adapter. Only storage carries the thread.
    const created: Record<string, unknown>[] = [];
    catalogue(request, created);

    const first = new OpenClawAdapterClient(profile(), {});
    await resolveResumeSession(first);
    first.disconnect();

    const rebuilt = new OpenClawAdapterClient(profile(), {});
    const outcome = await resolveResumeSession(rebuilt);

    expect(outcome.sessionId).toBe('oc_1');
    expect(creates(request)).toHaveLength(1);
    rebuilt.disconnect();
  });

  test('the owned ids are written under this gateway\'s own key, bounded to the newest 8', async () => {
    const created: Record<string, unknown>[] = [];
    catalogue(request, created);
    const adapter = new OpenClawAdapterClient(profile(), {});

    for (let index = 0; index < 11; index += 1) adapter.setSessionId(`oc_${index}`);
    await adapter.getSessions();

    const raw = await (AsyncStorage as { getItem: (key: string) => Promise<string | null> }).getItem(
      `${OWNED_SESSIONS_KEY_PREFIX}gw1`,
    );
    expect(raw).not.toBeNull();
    const ids = JSON.parse(raw as string) as string[];
    // Newest kept, oldest dropped: `oc_3` is the first evicted and `oc_10` the
    // last remembered. A set that re-added what it just deleted would drop
    // `oc_10` instead.
    expect(ids).toEqual(['oc_3', 'oc_4', 'oc_5', 'oc_6', 'oc_7', 'oc_8', 'oc_9', 'oc_10']);
    adapter.disconnect();
  });

  test('a session the gateway hosts for another surface is not adopted', async () => {
    request.mockResolvedValue({
      sessions: [{ id: 'tui-nightly', title: 'nightly sweep' }, { id: 'oc_1', title: 'scratch' }],
    });
    const adapter = new OpenClawAdapterClient(profile({ sessionId: 'oc_1' }), {});

    const outcome = await resolveResumeSession(adapter);

    expect(outcome.sessionId).toBe('oc_1');
    // Only the app's own rows are tagged; the rest stay foreign to pickAppSession.
    expect(outcome.sessions.map((session) => session.source)).toEqual(['openclaw', 'api_server']);
    expect(creates(request)).toHaveLength(0);
    adapter.disconnect();
  });

  test('a thread with no session of its own still opens exactly one session', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') return { sessions: [{ id: 'tui-nightly', title: 'nightly sweep' }] };
      if (method === 'sessions.create') return { id: 'oc_new', title: 'scratch' };
      return null;
    });
    const adapter = new OpenClawAdapterClient(profile(), {});

    const outcome = await resolveResumeSession(adapter);

    expect(outcome.sessionId).toBe('oc_new');
    expect(adapter.sessionId).toBe('oc_new');
    expect(creates(request)).toHaveLength(1);
    adapter.disconnect();
  });

  test('an unwritable store costs continuity, not the connect', async () => {
    const created: Record<string, unknown>[] = [];
    catalogue(request, created);
    const storage = AsyncStorage as unknown as {
      setItem: jest.Mock;
      getItem: jest.Mock;
    };
    storage.setItem.mockRejectedValue(new Error('disk full'));
    storage.getItem.mockRejectedValue(new Error('disk full'));

    const first = new OpenClawAdapterClient(profile(), {});
    // Still a working connect and a session: the store failure is swallowed.
    expect((await resolveResumeSession(first)).sessionId).toBe('oc_1');
    first.disconnect();

    const rebuilt = new OpenClawAdapterClient(profile(), {});
    const outcome = await resolveResumeSession(rebuilt);
    expect(outcome.sessionId).toBe('oc_1');
    // Nothing was stored, so nothing is owned and a session is opened — the
    // cost of a dead store is one orphan thread per launch, not a failed read.
    expect(creates(request)).toHaveLength(2);
    rebuilt.disconnect();
  });
});