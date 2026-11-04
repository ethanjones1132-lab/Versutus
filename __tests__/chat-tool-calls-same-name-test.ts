import { createChatStreamAcc, interpretChatStreamChunk } from '@/lib/gateway/chat-stream-delta';
import {
  addStreamingPlaceholder,
  appendToolCallDelta,
  finalizeStreamingMessage,
} from '@/lib/gateway/message-reducer';
import type { ChatMessage } from '@/lib/gateway/types';

/**
 * Two tool calls in a row must be two cards.
 *
 * An agent that runs `shell`, reads the result, then runs `shell` again reports
 * two invocations. The content-block path used to drop the call id, so both
 * frames reached the bubble as "a call named shell" and the reducer merged the
 * second into the first: one card for two pieces of work, showing the second
 * command's detail and the first card's history. The id is the only thing that
 * separates them, and a reused provider slot with a new id is new work — its
 * name, arguments and status start from nothing.
 */

function blockFrame(block: Record<string, unknown>) {
  return { choices: [{ delta: { content: [block] } }] };
}

function openFrame(toolCall: { index: number; id: string; name: string; arguments?: string }) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: toolCall.index,
              id: toolCall.id,
              function: { name: toolCall.name, arguments: toolCall.arguments },
              status: 'running',
            },
          ],
        },
      },
    ],
  };
}

function streaming(messages: ChatMessage[]): ChatMessage {
  return messages[0];
}

describe('two invocations of the same tool stay two cards', () => {
  test('content-block calls keep the id the provider gave each block', () => {
    const acc = createChatStreamAcc();
    const first = interpretChatStreamChunk(
      blockFrame({ type: 'tool_use', index: 0, id: 'toolu_1', name: 'shell', input: { command: 'ls' } }),
      acc,
    );
    const second = interpretChatStreamChunk(
      blockFrame({ type: 'tool_use', index: 1, id: 'toolu_2', name: 'shell', input: { command: 'pwd' } }),
      acc,
    );
    expect(first.toolCalls[0]).toMatchObject({ id: 'toolu_1', name: 'shell' });
    expect(second.toolCalls[0]).toMatchObject({ id: 'toolu_2', name: 'shell' });

    let messages = addStreamingPlaceholder([], 'run-1');
    messages = appendToolCallDelta(messages, 'run-1', first.toolCalls[0]);
    messages = appendToolCallDelta(messages, 'run-1', second.toolCalls[0]);

    expect(streaming(messages).toolCalls).toHaveLength(2);
    expect(streaming(messages).toolCalls?.map((call) => call.id)).toEqual(['toolu_1', 'toolu_2']);
  });

  test('a second invocation in a reused block slot starts running, not complete', () => {
    const acc = createChatStreamAcc();
    interpretChatStreamChunk(
      blockFrame({ type: 'tool_use', index: 0, id: 'toolu_1', name: 'shell', status: 'complete' }),
      acc,
    );
    const again = interpretChatStreamChunk(
      blockFrame({ type: 'tool_use', index: 0, id: 'toolu_2', name: 'shell', status: 'running' }),
      acc,
    );
    expect(again.toolCalls[0]).toMatchObject({ id: 'toolu_2', status: 'running' });
  });

  test('a later fragment of the first call still merges into that card', () => {
    const acc = createChatStreamAcc();
    const start = interpretChatStreamChunk(
      blockFrame({ type: 'tool_use', index: 0, id: 'toolu_1', name: 'shell', status: 'running' }),
      acc,
    );
    // Anthropic-shaped deltas carry only the block index; the id is remembered
    // per slot so this fragment stays the same call rather than a second card.
    const fragment = interpretChatStreamChunk(
      blockFrame({ type: 'tool_use', index: 0, name: 'shell', status: 'running' }),
      acc,
    );
    expect(fragment.toolCalls[0]).toMatchObject({ id: 'toolu_1', name: 'shell' });

    let messages = addStreamingPlaceholder([], 'run-1');
    for (const call of [...start.toolCalls, ...fragment.toolCalls]) {
      messages = appendToolCallDelta(messages, 'run-1', call);
    }
    expect(streaming(messages).toolCalls).toHaveLength(1);
  });

  test('a new id in a reused OpenAI slot resets the accumulated name and arguments', () => {
    const acc = createChatStreamAcc();
    interpretChatStreamChunk(openFrame({ index: 0, id: 'call-1', name: 'shell', arguments: '{"command":"ls"}' }), acc);
    const second = interpretChatStreamChunk(
      openFrame({ index: 0, id: 'call-2', name: 'read', arguments: '{"path":"a.ts"}' }),
      acc,
    );
    expect(second.toolCalls[0]).toMatchObject({
      id: 'call-2',
      name: 'read',
      detail: '{"path":"a.ts"}',
      status: 'running',
    });
  });

  test('two finalized cards keep their own terminal statuses', () => {
    let messages = addStreamingPlaceholder([], 'run-1');
    messages = appendToolCallDelta(messages, 'run-1', { id: 'toolu_1', name: 'shell', status: 'error', detail: 'denied' });
    messages = appendToolCallDelta(messages, 'run-1', { id: 'toolu_2', name: 'shell', status: 'running', detail: 'ls' });
    messages = finalizeStreamingMessage(messages, 'run-1');
    const calls = streaming(messages).toolCalls ?? [];
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ id: 'toolu_1', status: 'error', detail: 'denied' });
    expect(calls[1]).toMatchObject({ id: 'toolu_2', status: 'complete', detail: 'ls' });
  });

  test('an id announced before the name still opens the second card', () => {
    const acc = createChatStreamAcc();
    interpretChatStreamChunk(
      blockFrame({ type: 'tool_use', index: 0, id: 'toolu_1', name: 'shell', status: 'complete' }),
      acc,
    );
    // A block start can name the id alone; the tool's own name follows in a
    // later frame of the same slot. The id belongs to the slot from the moment
    // it is announced: remembered only when the name arrives, the nameless frame
    // above would leave the FIRST call's id in the slot and merge the second
    // call's name into the first card.
    const nameless = interpretChatStreamChunk(
      blockFrame({ type: 'tool_use', index: 0, id: 'toolu_2' }),
      acc,
    );
    expect(nameless.toolCalls).toEqual([]);
    const second = interpretChatStreamChunk(
      blockFrame({ type: 'tool_use', index: 0, name: 'read', status: 'running' }),
      acc,
    );
    expect(second.toolCalls[0]).toMatchObject({ id: 'toolu_2', name: 'read', status: 'running' });

    let messages = addStreamingPlaceholder([], 'run-1');
    messages = appendToolCallDelta(messages, 'run-1', {
      id: 'toolu_1', name: 'shell', status: 'complete', detail: 'ls',
    });
    for (const call of [...nameless.toolCalls, ...second.toolCalls]) {
      messages = appendToolCallDelta(messages, 'run-1', call);
    }
    const calls = streaming(messages).toolCalls ?? [];
    expect(calls.map((call) => call.id)).toEqual(['toolu_1', 'toolu_2']);
    expect(calls[0]).toMatchObject({ name: 'shell', detail: 'ls', status: 'complete' });
    expect(calls[1]).toMatchObject({ name: 'read' });
  });
});
