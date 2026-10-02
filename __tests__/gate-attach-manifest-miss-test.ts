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

// SPD-8: a known Gate with a manifest already on disk used to sit through the
// whole live-then-retry ladder (~21s of request time plus the retry sleep)
// before it could even begin connecting — the document that makes it a Gate was
// in storage the whole time.
describe('a known Gate that already has a manifest', () => {
  const REFRESHED = { ...GATE_MANIFEST, name: 'Versutus Gate (moved)' } as unknown as GatewayManifest;

  afterEach(() => jest.useRealTimers());

  /** A live fetch that stays outstanding until the test lets it land. */
  function heldFetch() {
    let land!: (manifest: GatewayManifest | null) => void;
    const fetchLive = jest.fn(
      () => new Promise<GatewayManifest | null>((resolve) => {
        land = resolve;
      }),
    );
    return { fetchLive, land: (manifest: GatewayManifest | null) => land(manifest) };
  }

  test('connects on the cached manifest instead of waiting for the live one', async () => {
    jest.useFakeTimers();
    const { fetchLive, land } = heldFetch();
    const sleep = jest.fn(async () => undefined);
    let settled = false;
    const pending = manifestForAttach({
      knownGate: true,
      fetchLive,
      loadCached: async () => GATE_MANIFEST,
      saveCached: async () => undefined,
      onLive: jest.fn(),
      sleep,
    }).then((result) => {
      settled = true;
      return result;
    });

    // Neither the request timeout nor the 0.9s retry sleep is on this path: the
    // connect is unblocked while the refresh is still outstanding.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(true);
    await expect(pending).resolves.toEqual({ manifest: GATE_MANIFEST, source: 'cached' });
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchLive).toHaveBeenCalledTimes(1);

    land(null);
  });

  test('the refresh that lands is saved and handed to the caller, never fetched again', async () => {
    jest.useFakeTimers();
    const { fetchLive, land } = heldFetch();
    const saveCached = jest.fn(async () => undefined);
    const onLive = jest.fn();
    await manifestForAttach({
      knownGate: true,
      fetchLive,
      loadCached: async () => GATE_MANIFEST,
      saveCached,
      onLive,
    });

    expect(saveCached).not.toHaveBeenCalled();
    land(REFRESHED);
    await jest.advanceTimersByTimeAsync(0);

    expect(saveCached).toHaveBeenCalledWith(REFRESHED);
    expect(onLive).toHaveBeenCalledWith(REFRESHED);
  });

  test('a refresh that fails or finds nothing changes nothing the connect depends on', async () => {
    jest.useFakeTimers();
    const saveCached = jest.fn(async () => undefined);
    const onLive = jest.fn();
    const failing = await manifestForAttach({
      knownGate: true,
      fetchLive: jest.fn(async () => {
        throw new Error('Network request failed');
      }),
      loadCached: async () => GATE_MANIFEST,
      saveCached,
      onLive,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(failing).toEqual({ manifest: GATE_MANIFEST, source: 'cached' });
    expect(saveCached).not.toHaveBeenCalled();
    expect(onLive).not.toHaveBeenCalled();

    const empty = await manifestForAttach({
      knownGate: true,
      fetchLive: jest.fn(async () => null),
      loadCached: async () => GATE_MANIFEST,
      saveCached,
      onLive,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(empty).toEqual({ manifest: GATE_MANIFEST, source: 'cached' });
    expect(onLive).not.toHaveBeenCalled();
  });

  test('a Gate with nothing cached still pays the retry before giving up', async () => {
    const noSleep = jest.fn(async () => undefined);
    const fetchLive = jest.fn(async () => null);
    const onLive = jest.fn();
    const result = await manifestForAttach({
      knownGate: true,
      fetchLive,
      loadCached: async () => null,
      saveCached: async () => undefined,
      onLive,
      sleep: noSleep,
    });
    expect(result).toEqual({ manifest: null, source: 'none' });
    expect(fetchLive).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalledWith(GATE_MANIFEST_RETRY_MS);
    expect(onLive).not.toHaveBeenCalled();
  });

  test('a profile not known as a Gate never reads the cache or starts a refresh', async () => {
    const onLive = jest.fn();
    const loadCached = jest.fn(async () => GATE_MANIFEST);
    const result = await manifestForAttach({
      knownGate: false,
      fetchLive: jest.fn(async () => REFRESHED),
      loadCached,
      saveCached: async () => undefined,
      onLive,
    });
    expect(result).toEqual({ manifest: REFRESHED, source: 'live' });
    expect(loadCached).not.toHaveBeenCalled();
    expect(onLive).not.toHaveBeenCalled();
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
    expect(attach).toContain('cachedManifest = await loadCachedGateManifest(manifestCacheId);');
    // The swallowed one-shot fetch that stranded the phone is gone.
    expect(attach).not.toMatch(/const manifest = await fetchGatewayManifestWithLookupRetry\(/);
  });

  test('a late manifest after a manifest-less connect rebuilds the client', () => {
    // The upgrade decision moved into the shared adopt path (SPD-1a): both the
    // background refresh a cached attach runs and the fetch a manifest-less
    // attach still owes land there, with the source each one came from.
    expect(attach).toContain('if (lateManifestUpgradesClient(source, manifest)) {');
    // The upgrade is the one automatic entry point that fires an attach which
    // rethrows, so it ends in the reporter like every other one: a refused key
    // here was an unhandled rejection with the screen still on the adapter.
    expect(attach).toContain('void upgradeClientRef.current(gateway).catch(reportAutoConnectFailure);');
    expect(attach).toContain('!options.upgrade &&');
    expect(attach).toContain('adoptLiveManifest(manifest, attachSource);');
    expect(attach).toContain("onLive: (served) => {");
    expect(src).toContain('upgradeClientRef.current = (gateway: GatewayProfile) => attachClient(gateway, { upgrade: true });');
  });

  test('a manifest this attach was just served is not fetched a second time', () => {
    // `live` was fetched milliseconds ago and `cached` is already refreshing in
    // the background behind `onLive`; only a manifest-less connect still owes
    // the read, and that is the upgrade path.
    expect(attach).toContain("if (attachSource !== 'none') return;");
    expect(attach.indexOf("if (attachSource !== 'none') return;")).toBeLessThan(
      attach.indexOf('manifestAlternateIpv4(gateway, fetchedManifest)'),
    );
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
