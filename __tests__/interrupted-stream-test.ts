import { markInterrupted, preserveInterruptedAfterReload } from '@/lib/gateway/message-reducer';
import type { ChatMessage } from '@/lib/gateway/types';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    text: 'partial answer',
    timestamp: 1_000,
    ...overrides,
  };
}

describe('preserveInterruptedAfterReload', () => {
  test('drops the interrupted bubble once history contains the finished turn', () => {
    const previous = markInterrupted(
      [{ ...message({ id: 'run-live', text: 'The answer is' }), streaming: true }],
      'live',
    );
    const history = [message({ id: 'h1', text: 'The answer is 42.', timestamp: 1_100 })];

    const result = preserveInterruptedAfterReload(history, previous);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('h1');
  });

  test('keeps the interrupted bubble when history has no matching turn', () => {
    const previous = [
      { ...message({ id: 'live', text: 'Only I have this' }), interrupted: true } as ChatMessage,
    ];
    const history = [message({ id: 'h1', text: 'Something unrelated', timestamp: 900 })];

    const result = preserveInterruptedAfterReload(history, previous);

    expect(result.map((item) => item.id)).toEqual(['h1', 'live']);
  });

  test('keeps an interrupted bubble that never produced any text', () => {
    const previous = [{ ...message({ id: 'live', text: '' }), interrupted: true } as ChatMessage];

    const result = preserveInterruptedAfterReload([], previous);

    expect(result.map((item) => item.id)).toEqual(['live']);
  });

  test('restores in timestamp order rather than appending blindly', () => {
    const previous = [
      { ...message({ id: 'live', text: 'orphan', timestamp: 1_050 }), interrupted: true } as ChatMessage,
    ];
    const history = [
      message({ id: 'h1', text: 'first', timestamp: 1_000 }),
      message({ id: 'h2', text: 'later', timestamp: 1_200 }),
    ];

    const result = preserveInterruptedAfterReload(history, previous);

    expect(result.map((item) => item.id)).toEqual(['h1', 'live', 'h2']);
  });

  test('ignores non-interrupted and non-assistant leftovers', () => {
    const previous = [
      message({ id: 'plain', text: 'not interrupted' }),
      { ...message({ id: 'user', role: 'user', text: 'hi' }), interrupted: true } as ChatMessage,
    ];
    const history = [message({ id: 'h1', text: 'answer', timestamp: 1_100 })];

    const result = preserveInterruptedAfterReload(history, previous);

    expect(result.map((item) => item.id)).toEqual(['h1']);
  });

  test('returns a fresh array and does not mutate the history it was given', () => {
    const history = [message({ id: 'h1' })];
    const result = preserveInterruptedAfterReload(history, []);

    expect(result).not.toBe(history);
    expect(history).toHaveLength(1);
  });
});

describe('markInterrupted', () => {
  test('stops streaming and flags the bubble so the UI can offer resume', () => {
    // The reducer keys the in-flight bubble as `run-${runId}`.
    const messages = [{ ...message({ id: 'run-live' }), streaming: true }];
    const result = markInterrupted(messages, 'live');

    expect(result[0].streaming).toBe(false);
    expect(result[0].interrupted).toBe(true);
  });

  test('is a no-op when the run id is not present', () => {
    const messages = [message({ id: 'other' })];
    const result = markInterrupted(messages, 'missing');

    expect(result[0].interrupted).toBeUndefined();
  });
});
