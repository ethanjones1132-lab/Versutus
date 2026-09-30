import { HttpTransport } from '@/lib/gateway/http-transport';
import { probeGatewayUrl } from '@/lib/gateway/probe';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

declare const __dirname: string;

// On the phone the roster showed "fetch failed: Fetch request has been
// canceled". Expo installs its native fetch as the global one, and a request
// cancelled through its AbortSignal rejects with a plain FetchError of that
// text — never a DOMException named AbortError. The transport's timeout
// mapping asked the error for that name, so a request that outran its timeout
// surfaced as a raw cancel naming no request.

/** A fetch that behaves like expo/fetch: it never answers, and an abort rejects plainly. */
function nativeLikeFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('fetch failed: Fetch request has been canceled')));
    })) as unknown as typeof fetch;
}

describe('a request that outruns its timeout on the native fetch', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  test('the transport names the request that timed out, not a raw cancel', async () => {
    global.fetch = nativeLikeFetch();
    const transport = new HttpTransport({ baseUrl: 'http://gate.test:8760', token: 't' } as never);
    await expect(transport.request('GET', '/v1/sessions', undefined, 20)).rejects.toThrow(
      'Request timed out: GET /v1/sessions',
    );
  });

  test('a real failure that is not our timeout still reaches the caller as itself', async () => {
    global.fetch = (async () => {
      throw new Error('fetch failed: Connection refused');
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({ baseUrl: 'http://gate.test:8760', token: 't' } as never);
    await expect(transport.request('GET', '/v1/sessions', undefined, 5_000)).rejects.toThrow('Connection refused');
  });

  test('a probe that outruns its timeout reports a timeout', async () => {
    global.fetch = nativeLikeFetch();
    const result = await probeGatewayUrl('http://gate.test:8760', 20);
    expect(result).toMatchObject({ ok: false, code: 'timeout', error: 'Timed out waiting for gateway' });
  });
});

describe('the access request keeps its timeout', () => {
  test('the timer is cleared only after the request settles', () => {
    const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
    const SEP = __dirname.includes('\\') ? '\\' : '/';
    const src = nodeFs.readFileSync([__dirname, '..', 'src', 'lib', 'portal', 'access.ts'].join(SEP), 'utf8');
    expect(src).toContain('return await fetch(candidateUrl, {');
    expect(src).not.toMatch(/\n\s+return fetch\(candidateUrl, \{/);
  });
});
