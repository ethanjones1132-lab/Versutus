import { createClientForKind } from '@/lib/portal/adapters';
import {
  GATE_MANIFEST_RETRY_MS,
  lateManifestUpgradesClient,
  manifestForAttach,
} from '@/lib/portal/attach-manifest';
import { gateSetupReach } from '@/lib/gateway/gate-setup-reach';
import { createGatewayProfile } from '@/lib/gateway/storage';
import type { GatewayManifest } from '@/lib/portal/manifest';
import type { GatewayIdentity } from '@/lib/portal/identify';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

declare const __dirname: string;

// The phone showed "providers.list is not supported by this gateway. The Hermes
// API server exposes N RPC-compatible methods" on Gate setup, while the same
// screen drew Gate-only data. A connect whose manifest fetch missed (a tailnet
// still waking) built the Gate's client without its manifest, so the factory
// handed it the Hermes adapter — and every Gate-only RPC then failed on the
// phone, before any request was made, for the rest of the session.

/** The Gate's own manifest, trimmed to what a client is built from. */
const GATE_MANIFEST: GatewayManifest = {
  manifest: 'versutus-gateway/v1',
  kind: 'versutus-gate',
  name: 'Versutus Gate',
  endpoints: { health: '/health', models: '/v1/models', capabilitiesRpc: '/v1/capabilities/rpc' },
  auth: { schemes: ['bearer'] },
} as unknown as GatewayManifest;

const gate = createGatewayProfile({ name: 'Atlas', url: 'http://100.95.137.83:8760', token: 't', kind: 'custom' });

function identityFrom(manifest: GatewayManifest): GatewayIdentity {
  return {
    kind: 'custom',
    kindLabel: 'Versutus Gate',
    manifest,
    auth: { schemes: ['bearer'], requiresToken: true },
    source: 'manifest',
    identifiedAt: 0,
  };
}

describe('the failure the phone showed', () => {
  test('a Gate built without its manifest answers Gate-only RPCs from the Hermes adapter', async () => {
    const client = createClientForKind('custom', gate, {}, undefined);
    await expect(client.rpcRequest('providers.list')).rejects.toThrow(/Hermes API server exposes/);
  });

  test('the same Gate built from its manifest sends them to the Gate', async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({ result: { data: [] } }), { status: 200 }));
    const realFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const client = createClientForKind('custom', gate, {}, identityFrom(GATE_MANIFEST));
      await expect(client.rpcRequest('providers.list')).resolves.toEqual({ data: [] });
      expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/v1/capabilities/rpc');
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe('the manifest a connect builds from', () => {
  const noSleep = jest.fn(async () => undefined);
  const reads = (answers: (GatewayManifest | null)[]) => {
    const queue = [...answers];
    return jest.fn(async () => queue.shift() ?? null);
  };

  beforeEach(() => noSleep.mockClear());

  test('a live manifest is used and kept for next time', async () => {
    const saveCached = jest.fn(async () => undefined);
    const result = await manifestForAttach({
      knownGate: true,
      fetchLive: reads([GATE_MANIFEST]),
      loadCached: async () => null,
      saveCached,
      sleep: noSleep,
    });
    expect(result).toEqual({ manifest: GATE_MANIFEST, source: 'live' });
    expect(saveCached).toHaveBeenCalledWith(GATE_MANIFEST);
    expect(noSleep).not.toHaveBeenCalled();
  });

  test('a known Gate that misses one fetch is asked once more', async () => {
    const fetchLive = reads([null, GATE_MANIFEST]);
    const result = await manifestForAttach({
      knownGate: true,
      fetchLive,
      loadCached: async () => null,
      saveCached: async () => undefined,
      sleep: noSleep,
    });
    expect(result.source).toBe('live');
    expect(fetchLive).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalledWith(GATE_MANIFEST_RETRY_MS);
  });

  test('a known Gate that misses twice builds from the last manifest it served', async () => {
    const result = await manifestForAttach({
      knownGate: true,
      fetchLive: reads([null, null]),
      loadCached: async () => GATE_MANIFEST,
      saveCached: async () => undefined,
      sleep: noSleep,
    });
    expect(result).toEqual({ manifest: GATE_MANIFEST, source: 'cached' });
  });

  test('a fetch that throws counts as a miss, never as a failed connect', async () => {
    const result = await manifestForAttach({
      knownGate: true,
      fetchLive: jest.fn(async () => {
        throw new Error('Network request failed');
      }),
      loadCached: async () => GATE_MANIFEST,
      saveCached: async () => undefined,
      sleep: noSleep,
    });
    expect(result.source).toBe('cached');
  });

  test('a gateway not known as a Gate (Hermes) pays no retry and reads no cache', async () => {
    const loadCached = jest.fn(async () => GATE_MANIFEST);
    const result = await manifestForAttach({
      knownGate: false,
      fetchLive: reads([null]),
      loadCached,
      saveCached: async () => undefined,
      sleep: noSleep,
    });
    expect(result).toEqual({ manifest: null, source: 'none' });
    expect(noSleep).not.toHaveBeenCalled();
    expect(loadCached).not.toHaveBeenCalled();
  });

  test('only a connect that had no manifest is rebuilt when one arrives', () => {
    expect(lateManifestUpgradesClient('none', GATE_MANIFEST)).toBe(true);
    expect(lateManifestUpgradesClient('none', null)).toBe(false);
    expect(lateManifestUpgradesClient('cached', GATE_MANIFEST)).toBe(false);
    expect(lateManifestUpgradesClient('live', GATE_MANIFEST)).toBe(false);
  });
});

describe('the provider connects through that seam', () => {
  const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const SEP = __dirname.includes('\\') ? '\\' : '/';
  const src = nodeFs
    .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
  const attach = src.slice(src.indexOf('const attachClient = useCallback('), src.indexOf('const connectGateway = useCallback('));

  test('attach reads its manifest through manifestForAttach, a saved Gate counting as known', () => {
    expect(attach).toContain('await manifestForAttach({');
    expect(attach).toContain("knownGate: gateway.kind === 'custom',");
    expect(attach).toContain('loadCached: () => loadCachedGateManifest(manifestCacheId),');
    // The swallowed one-shot fetch that stranded the phone is gone.
    expect(attach).not.toMatch(/const manifest = await fetchGatewayManifestWithLookupRetry\(/);
  });

  test('a late manifest after a manifest-less connect rebuilds the client', () => {
    expect(attach).toContain('if (lateManifestUpgradesClient(attachSource, manifest)) {');
    expect(attach).toContain('void upgradeClientRef.current(gateway);');
    expect(attach).toContain('!options.upgrade &&');
    expect(src).toContain('upgradeClientRef.current = (gateway: GatewayProfile) => attachClient(gateway, { upgrade: true });');
  });
});

describe('the same failure, answered honestly where it can still happen', () => {
  const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const SEP = __dirname.includes('\\') ? '\\' : '/';
  const read = (...parts: string[]) =>
    nodeFs.readFileSync([__dirname, '..', 'src', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');

  test('Gate setup knows a Gate, a Gate still answering, and a server that is not one', () => {
    expect(gateSetupReach({ status: 'connected', kind: 'custom', hasManifest: true })).toBe('gate');
    expect(gateSetupReach({ status: 'connected', kind: 'hermes', hasManifest: true })).toBe('gate');
    expect(gateSetupReach({ status: 'connected', kind: 'custom', hasManifest: false })).toBe('reaching-gate');
    expect(gateSetupReach({ status: 'connected', kind: 'hermes', hasManifest: false })).toBe('not-a-gate');
    expect(gateSetupReach({ status: 'connecting', kind: 'custom', hasManifest: true })).toBe('disconnected');
  });

  test('its Gate-only tabs give way to one card off a Gate; Manage stays', () => {
    const setup = read('app', 'gateway', 'setup.tsx');
    expect(setup).toContain("const gateOnly = section !== 'management' && (reach === 'not-a-gate' || reach === 'reaching-gate');");
    for (const section of ['providers', 'environments', 'capabilities', 'notifications']) {
      expect(setup).toContain(`{section === '${section}' && !gateOnly ? (`);
    }
    expect(setup).toContain("{section === 'management' ? (");
  });

  test('no empty claim is drawn under a failed read', () => {
    expect(read('components', 'gateway', 'providers-section.tsx')).toContain(
      "{loaded && providers.length === 0 && !registering && status === 'connected' && !error ? (",
    );
    expect(read('components', 'gateway', 'environments-section.tsx')).toContain(
      "{loaded && environments.length === 0 && !registering && !editing && status === 'connected' && !error ? (",
    );
  });

  test('push switches stay locked until the Gate\'s own preferences are read', () => {
    const hook = read('hooks', 'use-notification-preferences.ts');
    expect(hook.match(/setSynced\(true\);/g) ?? []).toHaveLength(2);
    const section = read('components', 'gateway', 'notifications-section.tsx');
    expect(section.match(/disabled=\{saving \|\| !synced\}/g) ?? []).toHaveLength(6);
    expect(section).not.toMatch(/disabled=\{saving\}/);
  });
});
