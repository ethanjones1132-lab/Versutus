declare const __dirname: string;

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

/**
 * The concurrency comment is the only guidance for tuning the wave cap, so it
 * must point at the probes' real timeout constants rather than a stale 1.8 s
 * figure the code has not used since the timeout was raised.
 */
describe('reachability wave timeout comment', () => {
  const src = readSource('src', 'lib', 'gateway', 'reachability-wave.ts');

  test('cites the probe timeout constants instead of the stale 1.8 s figure', () => {
    expect(src).not.toContain('1.8s');
    expect(src).toContain('GATEWAY_PROBE_TIMEOUT_MS');
    expect(src).toContain('GATEWAY_PROBE_PARALLEL_TIMEOUT_MS');
  });

  test('the cited constants are the ones probe.ts exports', () => {
    const probe = readSource('src', 'lib', 'gateway', 'probe.ts');
    expect(probe).toContain('export const GATEWAY_PROBE_TIMEOUT_MS');
    expect(probe).toContain('export const GATEWAY_PROBE_PARALLEL_TIMEOUT_MS');
  });
});
