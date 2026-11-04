import { createChatStreamAcc, interpretChatStreamChunk } from '@/lib/gateway/chat-stream-delta';
import { historyToChatMessages, readToolResult } from '@/lib/gateway/messages';
import {
  addStreamingPlaceholder,
  appendToolCallDelta,
  finalizeStreamingMessage,
} from '@/lib/gateway/message-reducer';

/**
 * A failed shell command must read Failed, not Done.
 *
 * A tool's outcome only exists in its result payload. The history mapper dropped
 * `role: 'tool'` messages entirely and stamped every call `complete`, and the
 * stream interpreter ignored `tool_result` blocks — so a call that errored
 * stayed `running` until the turn finalized it as `complete`. Both paths now
 * read the result itself: `is_error`, a non-empty `error`, `ok: false`, a
 * failed status, a non-zero exit code the payload actually carries, or text
 * that opens with an error. Nothing is inferred from an outcome the payload
 * does not report.
 */

function blockFrame(block: Record<string, unknown>) {
  return { choices: [{ delta: { content: [block] } }] };
}

describe('readToolResult reads the payload it was given', () => {
  test('structured failure witnesses', () => {
    expect(readToolResult({ is_error: true }).failed).toBe(true);
    expect(readToolResult({ isError: true }).failed).toBe(true);
    expect(readToolResult({ ok: false }).failed).toBe(true);
    expect(readToolResult({ success: false }).failed).toBe(true);
    expect(readToolResult({ failed: true }).failed).toBe(true);
    expect(readToolResult({ error: 'permission denied' }).failed).toBe(true);
    expect(readToolResult({ error: { message: 'nope' } }).failed).toBe(true);
    expect(readToolResult({ status: 'failed' }).failed).toBe(true);
    expect(readToolResult({ state: 'error' }).failed).toBe(true);
    expect(readToolResult({ exit_code: 1 }).failed).toBe(true);
    expect(readToolResult({ exitCode: 2 }).failed).toBe(true);
    expect(readToolResult(JSON.stringify({ ok: false, stderr: 'boom' }))).toEqual({
      failed: true,
      detail: 'boom',
    });
  });

  test('a healthy result is not a failure', () => {
    expect(readToolResult({ ok: true, output: 'all good' })).toEqual({
      failed: false,
      detail: 'all good',
    });
    expect(readToolResult({ exit_code: 0 }).failed).toBe(false);
    expect(readToolResult({ error: '' }).failed).toBe(false);
    expect(readToolResult('all good').failed).toBe(false);
    expect(readToolResult(undefined).failed).toBe(false);
  });

  test('a plain result whose own text opens with an error reads as failed', () => {
    expect(readToolResult('Error: cat: missing: No such file').failed).toBe(true);
    expect(readToolResult('Failed: command not found').failed).toBe(true);
    // A result that merely mentions an error further in is not a failure line.
    expect(readToolResult('stdout\nError: nested text').failed).toBe(false);
  });

  test('content blocks are read as one result', () => {
    expect(
      readToolResult([
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ]),
    ).toEqual({ failed: false, detail: 'line one\nline two' });
    expect(readToolResult([{ type: 'text', text: 'bad', is_error: true }]).failed).toBe(true);
  });
});

describe('history keeps a failed tool call failed', () => {
  test('a shell call followed by an error result is not Done', () => {
    const messages = historyToChatMessages([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'shell', arguments: '{"command":"cat missing"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: 'Error: cat: missing: No such file or directory',
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].toolCalls?.[0]).toMatchObject({ id: 'call-1', name: 'shell', status: 'error' });
    // The failure reason, not the arguments, is what the card must show.
    expect(messages[0].toolCalls?.[0].detail).toMatch(/No such file/);
  });

  test('a structured JSON failure settles as failed too', () => {
    const messages = historyToChatMessages([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'shell' } }],
      },
      { role: 'tool', tool_call_id: 'call-2', content: '{"exit_code":1,"stderr":"boom"}' },
    ]);
    expect(messages[0].toolCalls?.[0]).toMatchObject({ status: 'error', detail: 'boom' });
  });

  test('a successful result leaves the call Done and keeps its arguments', () => {
    const messages = historyToChatMessages([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call-3', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-3', content: 'file.txt' },
    ]);
    expect(messages[0].toolCalls?.[0]).toMatchObject({
      status: 'complete',
      detail: '{"command":"ls"}',
    });
  });

  test('a call with no result at all keeps the status it had', () => {
    const messages = historyToChatMessages([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-4', type: 'function', function: { name: 'shell' } }],
      },
    ]);
    expect(messages[0].toolCalls?.[0].status).toBe('complete');
  });

  test('chunks of one result fold into a single verdict', () => {
    const messages = historyToChatMessages([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call-7', type: 'function', function: { name: 'shell' } },
          { id: 'call-8', type: 'function', function: { name: 'shell' } },
        ],
      },
      // A failure witness in an earlier chunk is not undone by a later one...
      { role: 'tool', tool_call_id: 'call-7', content: 'Error: boom' },
      { role: 'tool', tool_call_id: 'call-7', content: 'ok' },
      // ...and the longest chunk is the detail that reaches the card.
      { role: 'tool', tool_call_id: 'call-8', content: 'partial' },
      { role: 'tool', tool_call_id: 'call-8', content: 'Error: the longer failure reason' },
    ]);
    expect(messages[0].toolCalls?.[0]).toMatchObject({ status: 'error', detail: 'Error: boom' });
    expect(messages[0].toolCalls?.[1]).toMatchObject({
      status: 'error',
      detail: 'Error: the longer failure reason',
    });
  });

  test('two identical invocations with different ids stay two cards', () => {
    const messages = historyToChatMessages([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call-5', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } },
          { id: 'call-6', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } },
        ],
      },
    ]);
    expect(messages[0].toolCalls?.map((call) => call.id)).toEqual(['call-5', 'call-6']);
  });
});

describe('the live stream settles a shell tool from its result', () => {
  test('a tool_result block with is_error turns the running card into Failed', () => {
    const acc = createChatStreamAcc();
    let messages = addStreamingPlaceholder([], 'run-1');

    const opened = interpretChatStreamChunk(
      blockFrame({
        type: 'tool_use',
        index: 0,
        id: 'toolu_1',
        name: 'shell',
        input: { command: 'ls /nope' },
      }),
      acc,
    );
    for (const call of opened.toolCalls) messages = appendToolCallDelta(messages, 'run-1', call);
    expect(messages[0].toolCalls?.[0].status).toBe('running');

    const result = interpretChatStreamChunk(
      blockFrame({
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        is_error: true,
        content: [{ type: 'text', text: 'ls: /nope: No such file or directory' }],
      }),
      acc,
    );
    expect(result.toolCalls).toEqual([
      {
        id: 'toolu_1',
        name: 'shell',
        status: 'error',
        detail: 'ls: /nope: No such file or directory',
      },
    ]);
    for (const call of result.toolCalls) messages = appendToolCallDelta(messages, 'run-1', call);

    // The turn ending must not promote a reported failure to Done.
    messages = finalizeStreamingMessage(messages, 'run-1');
    expect(messages[0].toolCalls?.[0]).toMatchObject({ status: 'error' });
  });

  test('a healthy tool_result completes the card', () => {
    const acc = createChatStreamAcc();
    const opened = interpretChatStreamChunk(
      blockFrame({ type: 'tool_use', index: 0, id: 'toolu_2', name: 'shell', input: { command: 'ls' } }),
      acc,
    );
    expect(opened.toolCalls[0].status).toBe('running');

    const result = interpretChatStreamChunk(
      blockFrame({
        type: 'tool_result',
        tool_use_id: 'toolu_2',
        content: [{ type: 'text', text: 'file.txt' }],
      }),
      acc,
    );
    expect(result.toolCalls).toEqual([
      { id: 'toolu_2', name: 'shell', status: 'complete', detail: 'file.txt' },
    ]);
  });

  test('a result for a call this stream never announced updates nothing', () => {
    const acc = createChatStreamAcc();
    const result = interpretChatStreamChunk(
      blockFrame({ type: 'tool_result', tool_use_id: 'toolu_missing', is_error: true }),
      acc,
    );
    expect(result.toolCalls).toEqual([]);
  });
});
