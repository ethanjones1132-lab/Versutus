import { memoryStatusCopy, memoryStatusFromUnknown } from '@/lib/gateway/memory-status';

// The `/memory` doctor status, read on demand when a Bot's sheet opens —
// the same reply the slash line renders, as one honest line beside the
// soul block. Read-first per the spec: this fold answers only what the
// Gate actually said, never invents a state, and a failed read stays a
// failed read (the same empty-vs-failed discipline the soul read pins).

test('a healthy doctor reply reads one status line', () => {
  const state = memoryStatusFromUnknown({
    status: 'ok',
    items: ['~/.hermes/memory/MEMORY.md'],
  });
  expect(state).toEqual({ loaded: true, failed: false, status: 'ok', detail: undefined });
  expect(memoryStatusCopy(state)).toBe('Memory doctor: ok');
});

test('an unhealthy doctor reply says so with its stated reason', () => {
  const state = memoryStatusFromUnknown({ status: 'degraded', reason: 'index out of date' });
  expect(state).toEqual({
    loaded: true,
    failed: false,
    status: 'degraded',
    detail: 'index out of date',
  });
  expect(memoryStatusCopy(state)).toBe('Memory doctor: degraded — index out of date');
});

test('a failed read never renders as healthy', () => {
  const state = memoryStatusFromUnknown(undefined);
  expect(state).toEqual({ loaded: false, failed: true, status: undefined, detail: undefined });
  expect(memoryStatusCopy(state)).toBe('Memory status could not be read.');
});

test('a reply with no status is a fact about the read, not the memory', () => {
  const state = memoryStatusFromUnknown({ items: [] });
  expect(state).toEqual({ loaded: false, failed: true, status: undefined, detail: undefined });
  expect(memoryStatusCopy(state)).toBe('Memory status could not be read.');
});

test('boolean status folds from ok/healthy truthfully', () => {
  expect(memoryStatusFromUnknown({ ok: true, healthy: true })?.status).toBe('ok');
  expect(memoryStatusFromUnknown({ ok: false })?.status).toBe('not ok');
});

test('raw uses the case the reply used, without re-wording the host', () => {
  expect(memoryStatusFromUnknown({ status: 'Healthy' })?.status).toBe('Healthy');
});

test('the /memory slash path stays untouched — this fold does not answer for it', () => {
  const state = memoryStatusFromUnknown({ status: 'wounded', attachLine: 'kept raw' });
  expect(state?.status).toBe('wounded');
  expect(state?.detail).toBeUndefined();
});

describe('the sheet wiring (source pins, the ui-contract pattern)', () => {
  const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const readSource = (...parts: string[]) =>
    nodeFs.readFileSync([__dirname, '..', ...parts].join('/'), 'utf8').replace(/\r\n/g, '\n');

  test('the sheet renders one read-only MEMORY row only when a read landed', () => {
    const src = readSource('src', 'components', 'chat', 'bot-detail-sheet.tsx');
    expect(src).toContain('memory?: MemoryStatusState');
    expect(src).toContain('{memory ? (');
    expect(src).toContain('{memoryStatusCopy(memory)}');
  });

  test('the chat gate attempts the doctor read only on an advertised Memory group', () => {
    const src = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    // The established capability gate, not a hopeful call.
    expect(src).toContain("group.id === 'memory'") ?? null;
    expect((src.match(/group\.id === 'memory'/g) ?? []).length).toBeGreaterThan(0);
    expect(src).toContain("gatewayRequest('doctor.memory.status', {})");
    expect(src).toContain('memory={memoryRead && detailBot && memoryRead.botId === detailBot.id ? memoryRead.state : undefined}');
  });
});
