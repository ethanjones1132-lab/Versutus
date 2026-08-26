import { loadGateways, upsertGateway } from '@/lib/gateway/storage';
import { secureKeyValueStorage } from '@/lib/storage/secure-key-value';
import type { GatewayProfile } from '@/lib/gateway/types';

jest.mock('@/lib/storage/secure-key-value', () => ({
  secureKeyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

const mockGet = secureKeyValueStorage.getItem as jest.Mock;
const mockSet = secureKeyValueStorage.setItem as jest.Mock;

const GATEWAYS_KEY = 'versutus:gateways';

/**
 * Gateway profiles persist as one JSON array. Two overlapping upserts each
 * load that array and the later write erases whatever the earlier one
 * changed — a model pin, a token, or another gateway entirely. These tests
 * pin the serialization: every mutation observes what the previous one wrote.
 */
describe('gateway profile store', () => {
  const backing = new Map<string, string>();

  const flushMicrotasks = async () => {
    for (let i = 0; i < 25; i += 1) await Promise.resolve();
  };

  const profile = (input: Partial<GatewayProfile> & Pick<GatewayProfile, 'id'>): GatewayProfile => ({
    name: 'Gate',
    url: 'http://127.0.0.1:8760',
    createdAt: 1,
    ...input,
  });

  const stored = (): GatewayProfile[] => {
    const raw = backing.get(GATEWAYS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as GatewayProfile[];
  };

  beforeEach(() => {
    backing.clear();
    mockGet.mockReset().mockImplementation(async (key: string) => backing.get(key) ?? null);
    mockSet.mockReset().mockImplementation(async (key: string, value: string) => {
      backing.set(key, value);
    });
  });

  test('overlapping upserts of two gateway profiles keep both', async () => {
    const hermes = profile({ id: 'gw-hermes', name: 'Hermes', token: 'listen-hermes' });
    const claw = profile({ id: 'gw-claw', name: 'OpenClaw', url: 'http://127.0.0.1:18789', token: 'listen-claw' });

    await Promise.all([upsertGateway(hermes), upsertGateway(claw)]);

    const ids = stored()
      .map((item) => item.id)
      .sort();
    expect(ids).toEqual(['gw-claw', 'gw-hermes']);
    expect(stored().find((item) => item.id === 'gw-hermes')?.token).toBe('listen-hermes');
    expect(stored().find((item) => item.id === 'gw-claw')?.token).toBe('listen-claw');
  });

  test('a later model pin is not overwritten by an in-flight kind write', async () => {
    const base = profile({ id: 'gw-1', token: 'listen-key' });
    backing.set(GATEWAYS_KEY, JSON.stringify([base]));

    let releaseFirst!: () => void;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstSetStarted!: () => void;
    const firstSetSeen = new Promise<void>((resolve) => {
      firstSetStarted = resolve;
    });
    let setCount = 0;
    mockSet.mockImplementation(async (key: string, value: string) => {
      setCount += 1;
      if (setCount === 1) {
        firstSetStarted();
        await firstHold;
      }
      backing.set(key, value);
    });

    const kindWrite = upsertGateway({ ...base, kind: 'custom' });
    await firstSetSeen;

    const modelWrite = upsertGateway({
      ...base,
      kind: 'custom',
      model: 'grok-4',
      token: 'listen-key',
    });
    await flushMicrotasks();

    // The kind write is still held. If the model upsert read underneath it,
    // its save already landed and this release will clobber the pin.
    releaseFirst();
    await Promise.all([kindWrite, modelWrite]);

    const [gateway] = stored();
    expect(gateway.model).toBe('grok-4');
    expect(gateway.token).toBe('listen-key');
    expect(gateway.kind).toBe('custom');
  });

  test('a queued mutation waits for the in-flight write instead of reading underneath it', async () => {
    let releaseWrite!: () => void;
    const writeHold = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    mockSet.mockImplementationOnce(async (key: string, value: string) => {
      await writeHold;
      backing.set(key, value);
    });

    const first = upsertGateway(profile({ id: 'gw-1', kind: 'custom' }));
    await flushMicrotasks();
    expect(mockGet).toHaveBeenCalledTimes(1);

    const second = upsertGateway(profile({ id: 'gw-1', kind: 'custom', model: 'grok-4', token: 'fresh' }));
    await flushMicrotasks();
    // The first upsert's write is still held, so the second must not have
    // read yet — reading now would build its array on pre-write state.
    expect(mockGet).toHaveBeenCalledTimes(1);

    releaseWrite();
    await Promise.all([first, second]);

    const [gateway] = stored();
    expect(gateway.model).toBe('grok-4');
    expect(gateway.token).toBe('fresh');
  });

  test('a failed write rejects its caller without stranding later mutations', async () => {
    mockSet.mockImplementationOnce(async () => {
      throw new Error('storage unavailable');
    });

    await expect(upsertGateway(profile({ id: 'gw-ghost', token: 'lost' }))).rejects.toThrow(
      'storage unavailable',
    );

    await upsertGateway(profile({ id: 'gw-ok', token: 'kept' }));

    const gateways = stored();
    expect(gateways.map((item) => item.id)).toEqual(['gw-ok']);
    expect(gateways[0].token).toBe('kept');
  });

  test('loadGateways returns what the last upsert persisted', async () => {
    await upsertGateway(profile({ id: 'gw-1', model: 'grok-4' }));
    expect(await loadGateways()).toEqual([profile({ id: 'gw-1', model: 'grok-4' })]);
  });
});
