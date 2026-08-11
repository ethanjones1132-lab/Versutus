import { manifestProviders, type GatewayManifest } from '@/lib/portal/manifest';

const baseManifest: GatewayManifest = {
  manifest: 'versutus-gateway/v1',
  kind: 'versutus-gate',
  name: 'Test Gate',
};

describe('manifestProviders', () => {
  test('returns an empty array when the manifest has no providers field', () => {
    expect(manifestProviders(baseManifest)).toEqual([]);
  });

  test('returns each well-formed provider entry', () => {
    const manifest: GatewayManifest = {
      ...baseManifest,
      providers: [
        { id: 'claude', label: 'Claude', basePath: '/p/claude', models: ['claude-opus-5'], capabilities: { chat: true, streaming: true } },
      ],
    };
    expect(manifestProviders(manifest)).toEqual([
      { id: 'claude', label: 'Claude', basePath: '/p/claude', models: ['claude-opus-5'], capabilities: { chat: true, streaming: true } },
    ]);
  });

  test('drops a malformed entry rather than throwing', () => {
    const manifest = {
      ...baseManifest,
      providers: [
        { id: 'claude', label: 'Claude', basePath: '/p/claude', models: ['claude-opus-5'], capabilities: {} },
        { id: 'broken' }, // missing basePath/models
        'not even an object',
      ],
    } as unknown as GatewayManifest;
    const result = manifestProviders(manifest);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('claude');
  });

  test('returns an empty array when providers is not an array', () => {
    const manifest = { ...baseManifest, providers: 'nope' } as unknown as GatewayManifest;
    expect(manifestProviders(manifest)).toEqual([]);
  });
});

import { identifyGateway } from '@/lib/portal/identify';

describe('identifyGateway carries providers through', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('a manifest with providers surfaces them on the identity', async () => {
    const manifest = {
      manifest: 'versutus-gateway/v1',
      kind: 'versutus-gate',
      auth: { schemes: ['bearer'] },
      providers: [
        { id: 'claude', label: 'Claude', basePath: '/p/claude', models: ['claude-opus-5'], capabilities: { chat: true } },
      ],
    };
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(manifest)),
      } as unknown as Response),
    );

    const identity = await identifyGateway({ baseUrl: 'http://gate.test:8760' });
    expect(identity.providers).toHaveLength(1);
    expect(identity.providers?.[0].id).toBe('claude');
  });
});
