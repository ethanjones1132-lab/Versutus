import { GROUP_SEND_TIMEOUT_MS, ManifestClient } from '@/lib/gateway/manifest-client';
import { DEFAULT_TIMEOUT_MS } from '@/lib/gateway/http-transport';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';

// Round-4 scan (R4S-p3b), GRP-1: a group send runs the whole planned round
// server-side, so the transport's 30 s default cut off a healthy round the Gate
// was still running. The send must carry a bound past any round the Gate can
// finish. This drives the real ManifestClient over a fetch that only settles on
// abort, so the assertion is about the timer the transport actually armed.

const PROFILE: GatewayProfile = {
  id: 'g1',
  name: 'Test gate',
  url: 'http://gate.test:8760',
  kind: 'custom',
  token: 'k',
  createdAt: 0,
};

const IDENTITY: GatewayIdentity = {
  kind: 'custom',
  kindLabel: 'Custom — versutus-gate',
  auth: { schemes: ['bearer'], requiresToken: true, grantPath: '/.well-known/gateway/access' },
  manifest: {
    manifest: 'versutus-gateway/v1',
    kind: 'versutus-gate',
    name: 'Test Gate',
    auth: { schemes: ['bearer'], grantPath: '/.well-known/gateway/access' },
    transport: { primary: 'http' },
    endpoints: { health: '/health', models: '/v1/models', chat: '/v1/chat/completions', botGroups: '/v1/bot-groups' },
    capabilities: { chat: true, models: true },
  },
  source: 'manifest',
  identifiedAt: 0,
};

describe('a group round is not cut off by the default request timeout', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('the send outlives the 30 s default and only ends at its own round bound', async () => {
    jest.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      (globalThis as { fetch: unknown }).fetch = jest.fn((_input: unknown, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        // Real fetch rejects when its controller aborts; the mock must too, or
        // the transport's timeout path never runs.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('canceled')));
        });
      });

      const client = new ManifestClient(PROFILE, IDENTITY, {});
      const pending = client.sendGroupMessage('room1', { text: 'status?' });
      const assertion = expect(pending).rejects.toThrow(/timed out/i);

      // Past the transport default the request is still in flight: the round
      // the Gate is running is never aborted on the phone.
      await jest.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS + 1_000);
      expect(signal?.aborted).toBe(false);

      await jest.advanceTimersByTimeAsync(GROUP_SEND_TIMEOUT_MS);
      expect(signal?.aborted).toBe(true);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });
});
