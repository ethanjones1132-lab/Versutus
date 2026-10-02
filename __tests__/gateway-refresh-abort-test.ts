import { withHostLookupRetry } from '@/lib/gateway/host-lookup';

// CAPS-1: refreshCapabilities ran its three reads strictly in series with no
// cancellation seam, so a superseding client replacement left health, the
// catalog and every manifest IPv4 candidate reading out to their own timeouts.
// A generation abort signal now reaches each stage. This drives the manifest
// retry helper directly: a supersede must stop it issuing further candidates.

describe('CAPS-1: a superseded refresh stops instead of walking the chain', () => {
  test('an already-aborted signal issues no attempt at all', async () => {
    const controller = new AbortController();
    controller.abort();
    const attempts: string[] = [];
    await expect(
      withHostLookupRetry(
        'http://gateway.test:8642',
        ['10.0.0.7', '10.0.0.8'],
        async (candidate) => {
          attempts.push(candidate);
          return candidate;
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(attempts).toEqual([]);
  });

  test('an abort mid-attempt stops the remaining IPv4 candidates', async () => {
    const controller = new AbortController();
    const attempts: string[] = [];
    const failure = new Error('getaddrinfo ENOTFOUND gateway.test');
    await expect(
      withHostLookupRetry(
        'http://gateway.test:8642',
        ['10.0.0.7', '10.0.0.8', '10.0.0.9'],
        async (candidate) => {
          attempts.push(candidate);
          // The first candidate fails as a lookup miss; the caller supersedes
          // the read right after, before the next candidate is tried.
          controller.abort();
          throw failure;
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    // Only the first attempt was made: the abort ended the chain.
    expect(attempts).toEqual(['http://gateway.test:8642']);
  });

  test('without a signal the whole candidate chain still runs as before', async () => {
    const attempts: string[] = [];
    const failure = new Error('getaddrinfo ENOTFOUND gateway.test');
    const result = await withHostLookupRetry(
      'http://gateway.test:8642',
      ['10.0.0.7'],
      async (candidate) => {
        attempts.push(candidate);
        if (candidate === 'http://gateway.test:8642') throw failure;
        return candidate;
      },
    );
    expect(attempts).toEqual(['http://gateway.test:8642', 'http://10.0.0.7:8642/']);
    expect(result).toBe('http://10.0.0.7:8642/');
  });
});

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

describe('CAPS-1: the refresh wires the generation abort into every stage', () => {
  test('the refresh captures the generation abort controller', () => {
    const refresh = refreshBody();
    expect(refresh).toContain('const abort = clientGenerationAbortRef.current;');
    expect(refresh).toContain('await raceAbort(client.healthCheck(), abort.signal);');
    expect(refresh).toContain('await raceAbort(client.getCapabilities(), abort.signal)');
    expect(refresh).toContain('abort.signal,');
  });

  test('every generation bump aborts the in-flight refresh chain', () => {
    const provider = nodeFs
      .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
      .replace(/\r\n/g, '\n');
    const bumps = provider.match(/clientGenerationRef\.current \+= 1;/g) ?? [];
    const aborts = provider.match(/clientGenerationAbortRef\.current\.abort\(\);/g) ?? [];
    expect(bumps).toHaveLength(4);
    expect(aborts).toHaveLength(4);
  });

  function refreshBody(): string {
    const provider = nodeFs
      .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
      .replace(/\r\n/g, '\n');
    const start = provider.indexOf('const refreshCapabilities = useCallback');
    expect(start).toBeGreaterThan(-1);
    return provider.slice(start, provider.indexOf('const confirmPendingAction = useCallback', start));
  }
});
