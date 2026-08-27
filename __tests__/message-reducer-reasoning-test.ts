import { addStreamingPlaceholder, appendReasoningDelta, finalizeStreamingMessage } from '@/lib/gateway/message-reducer';
import type { ChatMessage } from '@/lib/gateway/types';

describe('appendReasoningDelta', () => {
  test('accumulates reasoning on the streaming placeholder', () => {
    let messages: ChatMessage[] = addStreamingPlaceholder([], 'r1');
    messages = appendReasoningDelta(messages, 'r1', 'Think ');
    messages = appendReasoningDelta(messages, 'r1', 'about it');
    expect(messages).toHaveLength(1);
    expect(messages[0].reasoning).toBe('Think about it');
    expect(messages[0].streaming).toBe(true);
  });

  test('is a no-op when run id is not present', () => {
    let messages: ChatMessage[] = addStreamingPlaceholder([], 'r1');
    const next = appendReasoningDelta(messages, 'missing', 'hello');
    expect(next[0].reasoning).toBeUndefined();
  });

  test('reasoning survives finalize', () => {
    let messages: ChatMessage[] = addStreamingPlaceholder([], 'r1');
    messages = appendReasoningDelta(messages, 'r1', 'reasoning');
    messages = finalizeStreamingMessage(messages, 'r1');
    expect(messages[0].reasoning).toBe('reasoning');
    expect(messages[0].streaming).toBe(false);
  });
});
