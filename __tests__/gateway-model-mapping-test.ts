import { HermesGatewayClient } from '@/lib/gateway/client';
import type { GatewayProfile } from '@/lib/gateway/types';

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

const PROFILE: GatewayProfile = {
  id: 'g1', name: 'Test gateway', url: 'http://gateway.test:8642',
  kind: 'hermes', token: 'k', createdAt: 0,
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const OPTIONS = {
  providers: [
    { slug: 'nous', name: 'Nous Portal', models: ['poolside/laguna-xs-2.1:free'], authenticated: false },
  ],
};

/** What the one mapping must produce, pinned literally. */
const MAPPED = [
  {
    id: 'nous/poolside/laguna-xs-2.1:free',
    object: 'model',
    owned_by: 'nous',
    provider: 'Nous Portal',
    providerId: 'nous',
    modelId: 'poolside/laguna-xs-2.1:free',
    available: false,
  },
];

describe('both Hermes model paths share one mapping', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('the mapping is written once, not copied into getModels and the fallback', () => {
    const source = nodeFs
      .readFileSync([__dirname, '..', 'src', 'lib', 'gateway', 'client.ts'].join(SEP), 'utf8')
      .replace(/\r\n/g, '\n');
    // Two hand-written copies each called flattenHermesModelOptions(options)
    // and mapped the same six fields; the extraction leaves one call site.
    expect(source.match(/flattenHermesModelOptions\(options\)/g) ?? []).toHaveLength(1);
    expect(source.match(/modelsFromHermesOptions\(options\)/g) ?? []).toHaveLength(2);
  });

  test('getModels maps /api/model/options as it always did', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
      if (url.includes('/api/model/options')) return Promise.resolve(jsonResponse(OPTIONS));
      return Promise.resolve(jsonResponse({ error: 'Not Found' }, 404));
    });

    const models = await new HermesGatewayClient(PROFILE).getModels();
    expect(models).toEqual(MAPPED);
  });

  test('the remembered-Gate fallback maps the same body to the same rows', async () => {
    // First read: a Gate (native path 404s) answers /v1/models, so the client
    // remembers the Gate dialect. Second read: /v1/models 404s and the client
    // falls back through readHermesModelOptions. Both sites must still produce
    // MAPPED, exactly as the two hand-written copies did before the extraction.
    let phase = 1;
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
      if (url.includes('/api/model/options')) {
        return Promise.resolve(phase === 1 ? jsonResponse({ error: 'Not Found' }, 404) : jsonResponse(OPTIONS));
      }
      if (url.includes('/v1/models')) {
        return Promise.resolve(
          phase === 1 ? jsonResponse({ object: 'list', data: [] }) : jsonResponse({ error: 'Not Found' }, 404),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });

    const client = new HermesGatewayClient(PROFILE);
    await expect(client.getModels()).resolves.toEqual([]);
    phase = 2;
    await expect(client.getModels()).resolves.toEqual(MAPPED);
  });
});
