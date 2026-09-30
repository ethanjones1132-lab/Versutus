import { HermesGatewayClient } from '@/lib/gateway/client';
import { HEALTH_INTERVAL_MS } from '@/lib/gateway/connection-monitor';
import { ManifestClient } from '@/lib/gateway/manifest-client';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { ConnectionStatus, GatewayProfile } from '@/lib/gateway/types';

const HERMES_PROFILE: GatewayProfile = {
  id: 'g1',
  name: 'Test gateway',
  url: 'http://gateway.test:8642',
  kind: 'hermes',
  token: 'k',
  createdAt: 0,
};

const GATE_PROFILE: GatewayProfile = {
  id: 'g2',
  name: 'Test gate',
  url: 'http://gate.test:8760',
  kind: 'custom',
  token: 'k',
  createdAt: 0,
};

const GATE_IDENTITY: GatewayIdentity = {
  kind: 'custom',
  kindLabel: 'Custom — versutus-gate',
  auth: { schemes: ['bearer'], requiresToken: true, grantPath: '/.well-known/gateway/access' },
  manifest: {
    manifest: 'versutus-gateway/v1',
    kind: 'versutus-gate',
    name: 'Test Gate',
    auth: { schemes: ['bearer'], grantPath: '/.well-known/gateway/access' },
    transport: { primary: 'http' },
    endpoints: { health: '/health', models: '/v1/models', chat: '/v1/chat/completions' },
    capabilities: { chat: true, models: true },
  },
  source: 'manifest',
  identifiedAt: 0,
};

const HEALTH = { status: 'ok', platform: 'hermes-agent', version: '0.18.0' };
const MODELS = { object: 'list', data: [{ id: 'm1', object: 'model' }] };
const UNAUTHORIZED = { error: { message: 'Invalid token', code: 'invalid_api_key' } };

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

type StatusCall = { status: ConnectionStatus; detail?: string; authRejected?: boolean };

/** Both clients, so the two attemptConnect bodies cannot drift apart again. */
function bothClients(
  callbacks: { onStatus?: (status: ConnectionStatus, detail?: string, info?: { authRejected?: boolean }) => void },
) {
  return {
    hermes: new HermesGatewayClient(HERMES_PROFILE, callbacks),
    manifest: new ManifestClient(GATE_PROFILE, GATE_IDENTITY, callbacks),
  };
}

const realFetch = globalThis.fetch;

afterEach(() => {
  jest.useRealTimers();
  (globalThis as { fetch: unknown }).fetch = realFetch;
});

describe('a connect that loses its client goes quiet', () => {
  // disconnect() stops the monitor but cannot un-await a health call already
  // in flight. When that call answered, the attempt used to announce
  // 'connected' and start a 30s health interval against a gateway the
  // provider had already thrown away.
  beforeEach(() => jest.useFakeTimers());

  /**
   * A gateway whose /health never answers until the test releases it, so
   // disconnect() lands squarely inside the attempt.
   */
  function holdHealth() {
    let releaseHealth!: (response: Response) => void;
    const healthHold = new Promise<Response>((resolve) => {
      releaseHealth = resolve;
    });
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/health')) return healthHold;
      if (url.includes('/v1/models')) return Promise.resolve(jsonResponse(MODELS));
      return Promise.resolve(jsonResponse({ object: 'caps' }));
    });
    return () => releaseHealth(jsonResponse(HEALTH));
  }

  for (const kind of ['hermes', 'manifest'] as const) {
    test(`${kind}: health resolving after disconnect never reports connected or probes again`, async () => {
      const releaseHealth = holdHealth();
      const calls: StatusCall[] = [];
      const clients = bothClients({ onStatus: (status, detail, info) => calls.push({ status, detail, authRejected: info?.authRejected }) });
      const client = clients[kind];

      const attempt = client.connect();
      client.disconnect();
      releaseHealth();
      await attempt;
      // Let the interval have fired twice: before the fix, the abandoned
      // attempt's monitor.start() would be probing the dead client by now.
      await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 2);

      expect(calls.map((call) => call.status)).not.toContain('connected');
      expect(client.connectionStatus).toBe('disconnected');
      expect(jest.getTimerCount()).toBe(0);
    });

    test(`${kind}: connecting again after the disconnect works`, async () => {
      releaseHealthNothing();
      const calls: ConnectionStatus[] = [];
      const clients = bothClients({ onStatus: (status) => calls.push(status) });
      const client = clients[kind];

      await client.connect();
      expect(client.connectionStatus).toBe('connected');

      client.disconnect();
      expect(client.connectionStatus).toBe('disconnected');

      // A new epoch: the client is not left permanently mute after a cancel.
      await client.connect();
      expect(client.connectionStatus).toBe('connected');
      expect(calls.filter((status) => status === 'connected')).toHaveLength(2);
      client.disconnect();
    });
  }
});

function releaseHealthNothing() {
  (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/health')) return Promise.resolve(jsonResponse(HEALTH));
    if (url.includes('/v1/models')) return Promise.resolve(jsonResponse(MODELS));
    return Promise.resolve(jsonResponse({ object: 'caps' }));
  });
}

describe('an auth rejection says so in the status it announces', () => {
  // The provider's onStatus handler runs on setStatus('disconnected') BEFORE
  // the throw reaches the connect() caller, so it sees a plain disconnect and
  // schedules a retry that a wrong key can never satisfy.
  beforeEach(() => jest.useFakeTimers());

  function rejectAuth() {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/health')) return Promise.resolve(jsonResponse(HEALTH));
      if (url.includes('/v1/models')) return Promise.resolve(jsonResponse(UNAUTHORIZED, 401));
      if (url.includes('/v1/capabilities')) return Promise.resolve(jsonResponse(UNAUTHORIZED, 401));
      return Promise.resolve(jsonResponse({}));
    });
  }

  for (const kind of ['hermes', 'manifest'] as const) {
    test(`${kind}: the disconnect that names a bad credential carries authRejected`, async () => {
      rejectAuth();
      const calls: StatusCall[] = [];
      const clients = bothClients({ onStatus: (status, detail, info) => calls.push({ status, detail, authRejected: info?.authRejected }) });
      const client = clients[kind];

      await client.connect().catch(() => undefined);

      const announcement = calls.find((call) => call.status === 'disconnected');
      expect(announcement).toBeDefined();
      expect(announcement?.authRejected).toBe(true);
      expect(client.authRejected).toBe(true);
    });

    test(`${kind}: a later good key clears the rejection`, async () => {
      rejectAuth();
      const clients = bothClients({});
      const client = clients[kind];
      await client.connect().catch(() => undefined);
      expect(client.authRejected).toBe(true);

      // The operator pastes a working key: the client must stop claiming the
      // last failure was auth, or every later surface keeps naming a bad token
      // that has been replaced.
      releaseHealthNothing();
      client.disconnect();
      await client.connect();

      expect(client.authRejected).toBe(false);
      expect(client.connectionStatus).toBe('connected');
      client.disconnect();
    });

    test(`${kind}: an ordinary disconnect is not reported as an auth rejection`, async () => {
      releaseHealthNothing();
      const calls: StatusCall[] = [];
      const clients = bothClients({ onStatus: (status, detail, info) => calls.push({ status, detail, authRejected: info?.authRejected }) });
      const client = clients[kind];

      await client.connect();
      client.disconnect();

      for (const call of calls) {
        expect(call.authRejected).toBeUndefined();
      }
      expect(client.authRejected).toBe(false);
    });
  }
});

describe('nudge and forceReconnect reach the monitor through the client', () => {
  beforeEach(() => jest.useFakeTimers());

  /** Connected, then the gateway goes dark — no answer has arrived in 30s. */
  function darkGateway() {
    let up = true;
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/health')) {
        return up ? Promise.resolve(jsonResponse(HEALTH)) : Promise.reject(new TypeError('Network request failed'));
      }
      if (url.includes('/v1/models')) return Promise.resolve(jsonResponse(MODELS));
      return Promise.resolve(jsonResponse({ object: 'caps' }));
    });
    return {
      goDark() {
        up = false;
      },
    };
  }

  for (const kind of ['hermes', 'manifest'] as const) {
    test(`${kind}: a nudge on a dead gateway reaches reconnecting in ~2s`, async () => {
      const gateway = darkGateway();
      const clients = bothClients({});
      const client = clients[kind];
      await client.connect();

      gateway.goDark();
      // Clear the recent-contact evidence the connect just created, or the
      // monitor rightly reads the gateway as busy rather than gone.
      await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
      expect(client.connectionStatus).toBe('connected');

      client.nudge('stream stalled');
      await jest.advanceTimersByTimeAsync(2_500);

      expect(client.connectionStatus).toBe('reconnecting');
      client.disconnect();
    });

    test(`${kind}: forceReconnect re-verifies in place instead of rebuilding`, async () => {
      const gateway = darkGateway();
      const calls: StatusCall[] = [];
      const clients = bothClients({ onStatus: (status, detail, info) => calls.push({ status, detail, authRejected: info?.authRejected }) });
      const client = clients[kind];
      await client.connect();
      calls.length = 0;

      client.forceReconnect();
      // Announced before the attempt runs, so the operator sees why the
      // spinner is there rather than watching a silent hang.
      expect(calls[0]?.status).toBe('reconnecting');
      expect(calls[0]?.detail).toBe('Checking the connection');

      // Joins the attempt forceReconnect started — one attempt, one client.
      await client.connect();
      expect(client.connectionStatus).toBe('connected');
      expect(calls.filter((call) => call.status === 'connected')).toHaveLength(1);

      gateway.goDark();
      client.disconnect();
    });
  }
});
