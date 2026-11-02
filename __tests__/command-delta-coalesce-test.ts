import { createCommandDeltaBuffer } from '@/context/gateway-provider';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readProvider(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('@/lib/bot-avatar', () => ({ registerCrestFleet: jest.fn() }));
jest.mock('@/lib/discovery/scanner', () => ({
  isNativeDiscoveryAvailable: () => false,
  GatewayDiscoveryScanner: class {
    subscribe() {
      return () => undefined;
    }
    start() {}
  },
}));
jest.mock('@/lib/gateway/device-identity', () => ({}));
jest.mock('@/lib/notifications/local', () => ({}));
jest.mock('@/lib/notifications/push-registration', () => ({}));
jest.mock('@/lib/notifications/routine-sync', () => ({}));
jest.mock('@/lib/notifications/run-activity-device', () => ({}));
jest.mock('@/lib/portal/adapters', () => ({ createClientForKind: jest.fn() }));

/**
 * The provider wrote `updateLocalMessage` once per agent delta, so a command
 * that streamed 100 chunks re-rendered the provider and rewrote the transcript
 * row 100 times. These tests pin the coalescing buffer that replaces that: at
 * most one write per scheduled interval, the exact latest text, and an
 * explicit flush for the tail so no last delta is dropped.
 */
function makeHarness() {
  let scheduled: (() => void) | null = null;
  let scheduleCalls = 0;
  let cancelCalls = 0;
  const writes: string[] = [];
  const buffer = createCommandDeltaBuffer({
    write: (text) => writes.push(text),
    schedule: (cb) => {
      scheduleCalls += 1;
      scheduled = cb;
      return scheduleCalls;
    },
    cancel: () => {
      cancelCalls += 1;
      scheduled = null;
    },
  });
  return {
    buffer,
    writes,
    get scheduleCalls() {
      return scheduleCalls;
    },
    get cancelCalls() {
      return cancelCalls;
    },
    get hasScheduled() {
      return scheduled !== null;
    },
    /** Run the pending interval callback, as the timer would. */
    fire() {
      const cb = scheduled;
      scheduled = null;
      if (cb) cb();
    },
  };
}

describe('command delta coalescing — at most one transcript write per interval', () => {
  test('100 rapid deltas produce one write carrying the exact full text', () => {
    const h = makeHarness();

    for (let i = 0; i < 100; i += 1) h.buffer.queue('a'.repeat(i + 1));

    // Nothing is written before the interval elapses: the deltas are buffered.
    expect(h.writes).toEqual([]);
    expect(h.scheduleCalls).toBe(1);
    expect(h.buffer.pending).toBe('a'.repeat(100));

    h.fire();

    expect(h.writes).toEqual(['a'.repeat(100)]);
    expect(h.buffer.pending).toBeNull();
  });

  test('only the newest queued text is written, not every intermediate prefix', () => {
    const h = makeHarness();

    h.buffer.queue('hel');
    h.buffer.queue('hello');
    h.buffer.queue('hello world');
    h.fire();

    expect(h.writes).toEqual(['hello world']);
  });

  test('flush writes the buffered tail immediately and cancels the interval', () => {
    const h = makeHarness();

    h.buffer.queue('partial');
    h.buffer.flush();

    expect(h.writes).toEqual(['partial']);
    expect(h.cancelCalls).toBe(1);
    expect(h.hasScheduled).toBe(false);

    // The cancelled callback must never fire a second, stale write.
    h.fire();
    expect(h.writes).toEqual(['partial']);
  });

  test('flush with nothing buffered writes nothing', () => {
    const h = makeHarness();

    h.buffer.flush();

    expect(h.writes).toEqual([]);
    expect(h.scheduleCalls).toBe(0);
  });

  test('cancel drops the buffered tail without writing it', () => {
    const h = makeHarness();

    h.buffer.queue('superseded preview');
    h.buffer.cancel();

    expect(h.writes).toEqual([]);
    expect(h.buffer.pending).toBeNull();
    expect(h.hasScheduled).toBe(false);
    h.fire();
    expect(h.writes).toEqual([]);
  });

  test('a batch after a flush schedules and writes a second time, in order', () => {
    const h = makeHarness();

    h.buffer.queue('first');
    h.fire();
    h.buffer.queue('first second');
    h.fire();

    expect(h.writes).toEqual(['first', 'first second']);
    expect(h.scheduleCalls).toBe(2);
  });

  test('the last delta is never lost: queued after a write, then flushed', () => {
    const h = makeHarness();

    h.buffer.queue('streamed ');
    h.fire();
    h.buffer.queue('streamed tail');
    h.buffer.flush();

    expect(h.writes).toEqual(['streamed ', 'streamed tail']);
    expect(h.writes[h.writes.length - 1].endsWith('tail')).toBe(true);
  });
});

describe('the command path uses the buffer instead of a write per delta', () => {
  test('onAgentDelta accumulates the text and queues one coalesced write', () => {
    const src = readProvider();
    const at = src.indexOf('onAgentDelta: (delta) => {');
    expect(at).toBeGreaterThanOrEqual(0);
    const block = src.slice(at, src.indexOf('},', at) + 2);

    expect(block).toContain('streamedText += delta');
    expect(block).toContain('commandDelta.queue(streamedText)');
    // The defect: a transcript write (and provider render) per delta.
    expect(block).not.toContain('updateLocalMessage(');
  });

  test('the completion write drops any buffered preview that the result supersedes', () => {
    const src = readProvider();
    const result = src.indexOf('text: response.text,');
    expect(result).toBeGreaterThanOrEqual(0);
    const before = src.slice(Math.max(0, result - 400), result);
    expect(before).toContain('commandDelta.cancel()');
  });

  test('the cancel/failure path flushes the tail and the finally drops any timer', () => {
    const src = readProvider();
    // The catch's flush is the last one in the command path (the approval note
    // flushes earlier), so `lastIndexOf` pins the tail settle rather than the
    // note.
    const flushAt = src.lastIndexOf('commandDelta.flush()');
    const failedAt = src.indexOf('text: `Command failed: ${message}`');
    expect(flushAt).toBeGreaterThanOrEqual(0);
    // The tail is settled before the failure copy overwrites the bubble.
    expect(failedAt).toBeGreaterThan(flushAt);

    const finallyAt = src.indexOf('} finally {', flushAt);
    const finallyBlock = src.slice(finallyAt, src.indexOf('},', finallyAt) + 2);
    expect(finallyBlock).toContain('commandDelta.cancel()');
  });
});
