import { addStreamingPlaceholder } from '@/lib/gateway/message-reducer';
import { createStreamBatcher, isBatchEmpty, STREAM_BATCH_MS, createStreamBatch } from '@/lib/gateway/stream-batching';
import type { ChatMessage } from '@/lib/gateway/types';

function makeSetter() {
  let messages: ChatMessage[] = addStreamingPlaceholder([], 'test-run');
  const calls: number[] = [];
  const setMessages = (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    calls.push(1);
    messages = updater(messages);
  };
  return {
    get messages() {
      return messages;
    },
    get callCount() {
      return calls.length;
    },
    setMessages,
    reset() {
      calls.length = 0;
    },
  };
}

describe('stream-batching — coalescing deltas', () => {
  test('100 rapid deltas coalesce to one setMessages call with correct final text', () => {
    const s = makeSetter();
    let scheduled: (() => void) | null = null;
    const schedule = (cb: () => void): number => {
      if (!scheduled) scheduled = cb;
      return 1;
    };
    const batcher = createStreamBatcher({ runId: 'test-run', setMessages: s.setMessages, schedule, cancel: () => { scheduled = null; } });

    for (let i = 0; i < 100; i++) batcher.queueDelta('a');
    // Before flush: no React write yet — the 100 chunks are buffered.
    expect(s.callCount).toBe(0);
    expect(batcher.pending.text).toBe('a'.repeat(100));

    batcher.flush();
    expect(s.callCount).toBe(1);
    expect(s.messages[0].text).toBe('a'.repeat(100));
    expect(s.messages[0].streaming).toBe(true);
  });

  test('reasoning and text coalesce together in one flush', () => {
    const s = makeSetter();
    let scheduled: (() => void) | null = null;
    const schedule = (cb: () => void): number => {
      if (!scheduled) scheduled = cb;
      return 1;
    };
    const batcher = createStreamBatcher({ runId: 'test-run', setMessages: s.setMessages, schedule, cancel: () => { scheduled = null; } });

    batcher.queueDelta('hello ');
    batcher.queueReasoning('thinking ');
    batcher.queueDelta('world');
    batcher.queueReasoning('more');

    expect(s.callCount).toBe(0);
    batcher.flush();
    expect(s.callCount).toBe(1);
    expect(s.messages[0].text).toBe('hello world');
    expect(s.messages[0].reasoning).toBe('thinking more');
  });

  test('tool calls are flushed together with text', () => {
    const s = makeSetter();
    let scheduled: (() => void) | null = null;
    const batcher = createStreamBatcher({
      runId: 'test-run',
      setMessages: s.setMessages,
      schedule: (cb) => {
        if (!scheduled) scheduled = cb;
        return 1;
      },
      cancel: () => { scheduled = null; },
    });

    batcher.queueDelta('hi');
    batcher.queueTool({ name: 'search', status: 'running' });
    batcher.queueTool({ name: 'read', status: 'running' });
    expect(s.callCount).toBe(0);
    batcher.flush();
    expect(s.callCount).toBe(1);
    expect(s.messages[0].text).toBe('hi');
    expect(s.messages[0].toolCalls).toHaveLength(2);
  });

  test('empty queue does not emit a setMessages call', () => {
    const s = makeSetter();
    const batcher = createStreamBatcher({
      runId: 'test-run',
      setMessages: s.setMessages,
      schedule: (cb) => {
        cb();
        return 1;
      },
    });
    batcher.flush();
    expect(s.callCount).toBe(0);
  });

  test('second batch after flush emits a second call, not a merged one', () => {
    const s = makeSetter();
    let scheduled: (() => void) | null = null;
    const schedule = (cb: () => void): number => {
      if (!scheduled) scheduled = cb;
      return 1;
    };
    const batcher = createStreamBatcher({ runId: 'test-run', setMessages: s.setMessages, schedule, cancel: () => { scheduled = null; } });

    batcher.queueDelta('first');
    batcher.flush();
    expect(s.callCount).toBe(1);
    expect(s.messages[0].text).toBe('first');

    // new frame
    batcher.queueDelta(' second');
    batcher.flush();
    expect(s.callCount).toBe(2);
    expect(s.messages[0].text).toBe('first second');
  });

  test('cancel discards pending without a render', () => {
    const s = makeSetter();
    let scheduled: (() => void) | null = null;
    const batcher = createStreamBatcher({
      runId: 'test-run',
      setMessages: s.setMessages,
      schedule: (cb) => {
        if (!scheduled) scheduled = cb;
        return 1;
      },
      cancel: () => { scheduled = null; },
    });
    batcher.queueDelta('pending');
    batcher.queueReasoning('rm');
    expect(batcher.pending.text).toBe('pending');
    batcher.cancel();
    expect(isBatchEmpty(batcher.pending)).toBe(true);
    expect(s.callCount).toBe(0);
    batcher.flush();
    expect(s.callCount).toBe(0);
  });

  test('STREAM_BATCH_MS is 16ms (one frame)', () => {
    expect(STREAM_BATCH_MS).toBe(16);
  });

  test('createStreamBatch starts empty', () => {
    const b = createStreamBatch();
    expect(isBatchEmpty(b)).toBe(true);
    b.text = 'x';
    expect(isBatchEmpty(b)).toBe(false);
  });

  test('flushCount tracks how many flushed renders occurred', () => {
    const s = makeSetter();
    let scheduled: (() => void) | null = null;
    const schedule = (cb: () => void): number => {
      if (!scheduled) scheduled = cb;
      return 1;
    };
    const batcher = createStreamBatcher({ runId: 'test-run', setMessages: s.setMessages, schedule, cancel: () => { scheduled = null; } });
    expect(batcher.flushCount).toBe(0);
    batcher.queueDelta('a');
    batcher.flush();
    expect(batcher.flushCount).toBe(1);
    batcher.queueDelta('b');
    batcher.flush();
    expect(batcher.flushCount).toBe(2);
  });
});
