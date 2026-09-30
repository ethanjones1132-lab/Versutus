import { HermesGatewayClient } from '@/lib/gateway/client';
import { HEALTH_INTERVAL_MS } from '@/lib/gateway/connection-monitor';
import { StreamStalledError } from '@/lib/gateway/errors';
import { GET_SESSIONS_ATTEMPT_TIMEOUT_MS } from '@/lib/gateway/get-sessions-retry';
import { ManifestClient } from '@/lib/gateway/manifest-client';
import type {
  ConnectionStatus,
  GatewayProfile,
  HermesSession,
  RunStatus,
} from '@/lib/gateway/types';
import type { GatewayIdentity } from '@/lib/portal/identify';

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
  providers: [
    { id: 'p1', label: 'Test provider', basePath: '/v1', models: ['m1'], capabilities: { chat: true } },
  ],
  manifest: {
    manifest: 'versutus-gateway/v1',
    kind: 'versutus-gate',
    name: 'Test Gate',
    auth: { schemes: ['bearer'], grantPath: '/.well-known/gateway/access' },
    transport: { primary: 'http' },
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
      sessions: '/v1/sessions',
      runs: '/v1/runs',
      runStatus: '/v1/runs/{run_id}',
    },
    capabilities: { chat: true, models: true, runs: true, sessions: true },
  },
  source: 'manifest',
  identifiedAt: 0,
};

const HEALTH = { status: 'ok', platform: 'hermes-agent', version: '0.18.0' };
const MODELS = { object: 'list', data: [{ id: 'm1', object: 'model' }] };
const CAPABILITIES = { object: 'caps', features: { chat_completions: true } };

/** A snapshot of what the gateway is doing, counted as tests set it. */
type GatewayState = {
  healthUp: boolean;
  /** Every probe the monitor asked for, which is what "did it nudge" means. */
  healthProbes: number;
  faultRunReads: boolean;
  hangSessionLists: boolean;
  stallChatStreams: boolean;
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/** A request that never answers until HttpTransport's own budget aborts it. */
function untilAborted(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('request cancelled')), { once: true });
  });
}

/** A real ReadableStream that opens and then never yields a byte. */
function stalledStream(): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'x-versutus-keepalive-ms' ? '1000' : null),
    },
    body: new ReadableStream<Uint8Array>({
      start() {
        // a dead radio: the stream opens and stays empty
      },
    }),
  } as unknown as Response;
}

/** Routes by path so tests set outcomes; /health is counted for the nudge. */
function fakeGateway(state: GatewayState) {
  (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/health')) {
      state.healthProbes += 1;
      return state.healthUp
        ? Promise.resolve(jsonResponse(HEALTH))
        : Promise.reject(new TypeError('fetch failed: Network request failed'));
    }
    if (state.hangSessionLists && url.includes('/sessions')) return untilAborted(init);
    if (state.faultRunReads && url.includes('/v1/runs/')) {
      return Promise.reject(new TypeError('fetch failed: Network request failed'));
    }
    if (state.stallChatStreams && url.includes('/chat/completions')) {
      return Promise.resolve(stalledStream());
    }
    if (url.includes('/v1/models')) return Promise.resolve(jsonResponse(MODELS));
    if (url.includes('/v1/capabilities')) return Promise.resolve(jsonResponse(CAPABILITIES));
    return Promise.resolve(jsonResponse({}));
  });
}

/**
 * Only the surface both dialects share, so one suite covers the Hermes wiring
 * and the manifest wiring and neither can drift apart unnoticed.
 */
type NudgedClient = {
  readonly connectionStatus: ConnectionStatus;
  connect(): Promise<void>;
  disconnect(): void;
  updateProfile(profile: GatewayProfile): void;
  getSessions(limit?: number): Promise<HermesSession[]>;
  getRunStatus(runId: string): Promise<RunStatus>;
  streamChat(messages: { role: string; content: string }[], onDelta: (text: string) => void): Promise<string>;
};

function bothClients(): Record<'hermes' | 'manifest', NudgedClient> {
  return {
    hermes: new HermesGatewayClient(HERMES_PROFILE, {}),
    manifest: new ManifestClient(GATE_PROFILE, GATE_IDENTITY, {}),
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('transport trouble reaches the connection monitor', () => {
  // Without the hook, a dead path is only visible after two failed 30s samples:
  // 42-72s of a chat that is already dead.
  const realFetch = globalThis.fetch;
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  for (const kind of ['hermes', 'manifest'] as const) {
    test(`${kind}: a timed-out read re-probes the path instead of waiting out the interval`, async () => {
      const state: GatewayState = {
        healthUp: true,
        healthProbes: 0,
        faultRunReads: false,
        hangSessionLists: true,
        stallChatStreams: false,
      };
      fakeGateway(state);
      const client = bothClients()[kind];
      await client.connect();
      expect(client.connectionStatus).toBe('connected');

      state.healthUp = false;
      // The first 30s sample is the lone failure the next one has to agree with.
      await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
      expect(client.connectionStatus).toBe('connected');
      const probesBefore = state.healthProbes;

      // A session read that never lands: HttpTransport's per-attempt budget is
      // what finally gives up on it, and that timeout is the trouble signal.
      void client.getSessions().catch(() => undefined);
      await jest.advanceTimersByTimeAsync(GET_SESSIONS_ATTEMPT_TIMEOUT_MS - 1);
      expect(state.healthProbes).toBe(probesBefore);

      await jest.advanceTimersByTimeAsync(1);
      await flush();
      // Exactly one probe: the monitor's own failure must not chain more, and
      // the cooldown keeps the rest out.
      expect(state.healthProbes).toBe(probesBefore + 1);
      // The second sample arrives with the transport's own timeout instead of
      // at the next 30s tick, 22s away — which is the whole point of the hook.
      expect(client.connectionStatus).toBe('reconnecting');

      client.disconnect();
    });

    test(`${kind}: a stalled stream asks for one verdict and leaves a healthy gateway alone`, async () => {
      const state: GatewayState = {
        healthUp: true,
        healthProbes: 0,
        faultRunReads: false,
        hangSessionLists: false,
        stallChatStreams: true,
      };
      fakeGateway(state);
      const client = bothClients()[kind];
      await client.connect();
      const probesBefore = state.healthProbes;

      // The keepalive header arms a 3s idle watchdog; the stream never yields a
      // byte, so the real StreamStalledError path fires.
      const pending = client.streamChat([{ role: 'user', content: 'hello' }], () => undefined);
      const assertion = expect(pending).rejects.toBeInstanceOf(StreamStalledError);
      await jest.advanceTimersByTimeAsync(3000);
      await assertion;
      await flush();

      // One probe, and a path that answers it is not disturbed: no status
      // change, and nothing queued behind a verdict nobody needs.
      expect(state.healthProbes).toBe(probesBefore + 1);
      expect(client.connectionStatus).toBe('connected');
      await jest.advanceTimersByTimeAsync(10_000);
      expect(state.healthProbes).toBe(probesBefore + 1);

      client.disconnect();
    });

    test(`${kind}: ten troubles inside the cooldown produce one probe`, async () => {
      const state: GatewayState = {
        healthUp: true,
        healthProbes: 0,
        faultRunReads: true,
        hangSessionLists: false,
        stallChatStreams: false,
      };
      fakeGateway(state);
      const client = bothClients()[kind];
      await client.connect();
      const probesBefore = state.healthProbes;

      // A flapping path fails every read it sends. One probe per window is the
      // whole point: ten complaints must not become ten verdicts.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await client.getRunStatus('r1').catch(() => undefined);
        await flush();
        await jest.advanceTimersByTimeAsync(300);
      }

      expect(state.healthProbes).toBe(probesBefore + 1);
      expect(client.connectionStatus).toBe('connected');

      client.disconnect();
    });

    test(`${kind}: trouble after disconnect does nothing`, async () => {
      const state: GatewayState = {
        healthUp: true,
        healthProbes: 0,
        faultRunReads: false,
        hangSessionLists: false,
        stallChatStreams: false,
      };
      fakeGateway(state);
      const client = bothClients()[kind];
      await client.connect();

      // The same trouble while the client is live does probe, so the silence
      // after disconnect below is the guard and not a mock that never fires.
      state.faultRunReads = true;
      const probesBefore = state.healthProbes;
      await client.getRunStatus('r1').catch(() => undefined);
      await flush();
      expect(state.healthProbes).toBe(probesBefore + 1);

      client.disconnect();
      expect(jest.getTimerCount()).toBe(0);

      // A late failure on a client the provider threw away must not start an
      // interval, a probe or a reconnect against a gateway nobody is watching.
      const probesAtDisconnect = state.healthProbes;
      await client.getRunStatus('r1').catch(() => undefined);
      await flush();
      await jest.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);

      expect(state.healthProbes).toBe(probesAtDisconnect);
      expect(client.connectionStatus).toBe('disconnected');
      expect(jest.getTimerCount()).toBe(0);
    });

    test(`${kind}: updateProfile keeps the trouble hook wired`, async () => {
      const state: GatewayState = {
        healthUp: true,
        healthProbes: 0,
        faultRunReads: false,
        hangSessionLists: false,
        stallChatStreams: false,
      };
      fakeGateway(state);
      const client = bothClients()[kind];
      await client.connect();

      // HttpTransport.update REPLACES its options, so a profile change used to
      // drop the hook and leave the first connection change unprotected.
      const moved = kind === 'hermes' ? HERMES_PROFILE : GATE_PROFILE;
      client.updateProfile({ ...moved, url: 'http://gateway.test:9999', token: 'k2' });
      const probesBefore = state.healthProbes;

      state.faultRunReads = true;
      await client.getRunStatus('r1').catch(() => undefined);
      await flush();
      await jest.advanceTimersByTimeAsync(10);

      expect(state.healthProbes).toBe(probesBefore + 1);
      expect(client.connectionStatus).toBe('connected');

      client.disconnect();
    });
  }
});
