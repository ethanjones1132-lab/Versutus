import { memoryStatusCopy, memoryStatusFromUnknown } from '@/lib/gateway/memory-status';

// The Memory doctor answers `doctor.memory.status` as a status block; the
// reply rendered in chat today was the raw payload. This fold answers the
// same read as one honest line shown where gateway health already shows.
// The status is HOST-wide (memory lives on the gateway host, rpc-routes
// guidance) — the copy must never claim it describes one Bot. A reply the
// fold cannot read is a fact about the read, not the memory: unknown, and
// never healthy.

test('a healthy doctor reply reads one status line', () => {
  const state = memoryStatusFromUnknown({
    status: 'ok',
    items: ['~/.hermes/memory/MEMORY.md'],
  });
  expect(state).toEqual({ loaded: true, failed: false, status: 'ok', detail: undefined });
  expect(memoryStatusCopy(state)).toBe('Memory doctor: ok (host-wide)');
});

test('an unhealthy doctor reply says so with its stated reason', () => {
  const state = memoryStatusFromUnknown({ status: 'degraded', reason: 'index out of date' });
  expect(state).toEqual({
    loaded: true,
    failed: false,
    status: 'degraded',
    detail: 'index out of date',
  });
  expect(memoryStatusCopy(state)).toBe('Memory doctor: degraded (host-wide) — index out of date');
});

// The whole point of the fold: a body the host reported but the fold cannot
// read is UNKNOWN, never the healthy default a `??` chain would produce.
test('an unreadable payload is unknown, not healthy, and says so', () => {
  expect(memoryStatusFromUnknown(undefined).failed).toBe(true);
  expect(memoryStatusFromUnknown('garbage').failed).toBe(true);
  expect(memoryStatusFromUnknown([]).failed).toBe(true);
  expect(memoryStatusFromUnknown(null).failed).toBe(true);
  const opaque = memoryStatusFromUnknown({ stores: [{ file: 'MEMORY.md' }, { file: 'USER.md' }] });
  expect(opaque.failed).toBe(true);
  expect(memoryStatusCopy(opaque)).toBe('Memory status could not be read.');
});

test('a boolean verdict folds truthfully, and never as healthy', () => {
  expect(memoryStatusFromUnknown({ ok: true, healthy: true })?.status).toBe('ok');
  expect(memoryStatusFromUnknown({ ok: false })?.status).toBe('not ok');
  expect(memoryStatusFromUnknown({ healthy: false }).failed).toBe(false);
});

test('the status word stays as the host said it', () => {
  expect(memoryStatusFromUnknown({ status: 'Healthy' })?.status).toBe('Healthy');
});

test('the one line never names a Bot — this status is the host, not one Bot', () => {
  const line = memoryStatusCopy(
    memoryStatusFromUnknown({ status: 'ok', reason: 'index warm' }),
  );
  expect(line).toContain('host-wide');
  expect(line.toLowerCase()).not.toContain('bot');
});

describe('the pane wiring (source pins, the ui-contract pattern)', () => {
  const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const readSource = (...parts: string[]) =>
    nodeFs.readFileSync(
      parts.join('/').replace(/^\//, ''),
      'utf8',
    ).replace(/\r\n/g, '\n');

  const pane = () => readSource('src', 'components', 'gateway', 'health-checks-pane.tsx');

  test('the pane reads the doctor on demand and renders one line', () => {
    const src = pane();
    expect(src).toContain("gatewayRequest('doctor.memory.status', {})");
    expect(src).toContain('memoryStatusCopy');
    // One honest line, no raw JSON rendering of the payload.
    expect(src).not.toContain('compactJson');
  });

  test('a failed fold renders the unknown line, same route as success', () => {
    expect(memoryStatusCopy(memoryStatusFromUnknown(null))).toBe(
      'Memory status could not be read.',
    );
  });
});
