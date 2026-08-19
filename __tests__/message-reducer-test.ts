import { MESSAGE_WINDOW_CAP } from '@/lib/gateway/messages';
import {
  addStreamingPlaceholder,
  addUserMessage,
  appendStreamDelta,
  appendToolCallDelta,
  convertStreamError,
  finalizeStreamingMessage,
  markInterrupted,
  reconcileInterruptedMessages,
} from '@/lib/gateway/message-reducer';
import type { ChatMessage } from '@/lib/gateway/types';

describe('message reducer regression locks', () => {
  test('user messages append and stay bounded', () => {
    let messages: ChatMessage[] = [];
    for (let i = 0; i < MESSAGE_WINDOW_CAP + 10; i += 1) {
      messages = addUserMessage(messages, `turn ${i}`);
    }
    expect(messages.length).toBe(MESSAGE_WINDOW_CAP);
    expect(messages[0].text).toBe('turn 10');
    expect(messages[MESSAGE_WINDOW_CAP - 1].text).toBe(`turn ${MESSAGE_WINDOW_CAP + 9}`);
  });

  test('streaming placeholder is appended and bounded', () => {
    let messages: ChatMessage[] = [];
    for (let i = 0; i < MESSAGE_WINDOW_CAP + 5; i += 1) {
      messages = addStreamingPlaceholder(messages, String(i));
    }
    expect(messages.length).toBe(MESSAGE_WINDOW_CAP);
    expect(messages[0].id).toBe(`run-5`);
  });

  test('streamed deltas accumulate on the placeholder', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = appendStreamDelta(messages, 'r1', 'Hello');
    messages = appendStreamDelta(messages, 'r1', ' world');
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('Hello world');
    expect(messages[0].streaming).toBe(true);
  });

  test('tool call deltas merge by name', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = appendToolCallDelta(messages, 'r1', { name: 'read', status: 'running', detail: 'a' });
    messages = appendToolCallDelta(messages, 'r1', { name: 'read', status: 'complete', detail: 'b' });
    messages = appendToolCallDelta(messages, 'r1', { name: 'write', status: 'running' });
    expect(messages[0].toolCalls).toHaveLength(2);
    expect(messages[0].toolCalls?.[0]).toEqual({ name: 'read', status: 'complete', detail: 'b' });
    expect(messages[0].toolCalls?.[1]).toEqual({ name: 'write', status: 'running' });
  });

  test('finalize marks streaming false and completes running tools', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = appendToolCallDelta(messages, 'r1', { name: 'read', status: 'running' });
    messages = finalizeStreamingMessage(messages, 'r1');
    expect(messages[0].streaming).toBe(false);
    expect(messages[0].toolCalls?.[0].status).toBe('complete');
  });

  test('a non-abort error keeps the assistant bubble', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = convertStreamError(messages, 'r1', 'Gateway timed out', false);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('Error: Gateway timed out');
    expect(messages[0].streaming).toBe(false);
  });

  test('an abort removes the placeholder', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = convertStreamError(messages, 'r1', 'User cancelled', true);
    expect(messages).toHaveLength(0);
  });

  test('a thousand streamed deltas never exceed the window cap', () => {
    let messages = addUserMessage([], 'seed');
    messages = addStreamingPlaceholder(messages, 'r1');
    for (let i = 0; i < 1000; i += 1) {
      messages = appendStreamDelta(messages, 'r1', `${i} `);
    }
    expect(messages.length).toBeLessThanOrEqual(MESSAGE_WINDOW_CAP);
  });

  test('markInterrupted sets interrupted flag and stops streaming', () => {
    let messages = addStreamingPlaceholder([], 'r1');
    messages = markInterrupted(messages, 'r1');
    expect(messages[0].streaming).toBe(false);
    expect(messages[0].interrupted).toBe(true);
  });

  test('reconcileInterruptedMessages replaces an interrupted bubble with the authoritative history turn', () => {
    let current = addStreamingPlaceholder([], 'r1');
    current = appendStreamDelta(current, 'r1', 'Partial answer');
    current = markInterrupted(current, 'r1');

    const history: ChatMessage[] = [
      { id: 'hist-1', role: 'assistant', text: 'Partial answer that continued to completion' },
    ];

    const result = reconcileInterruptedMessages(current, history);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('hist-1');
    expect(result[0].interrupted).toBeFalsy();
  });

  test('reconcileInterruptedMessages keeps the bubble when history has no match', () => {
    let current = addStreamingPlaceholder([], 'r1');
    current = appendStreamDelta(current, 'r1', 'Partial answer');
    current = markInterrupted(current, 'r1');

    const result = reconcileInterruptedMessages(current, []);
    expect(result[0].interrupted).toBe(true);
  });
});
