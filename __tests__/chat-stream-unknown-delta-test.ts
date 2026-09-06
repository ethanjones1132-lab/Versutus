import { createChatStreamAcc, interpretChatStreamChunk } from '@/lib/gateway/chat-stream-delta';

const globals = globalThis as typeof globalThis & { __DEV__?: boolean };

/**
 * `interpretChatStreamChunk` reads array-form `delta.content` for tool calls,
 * but only from four known block types (`tool_use`, `tool_call`,
 * `function_call`, `tool`). A future provider can introduce a new block kind
 * carrying a tool call — the Gate relays chunks verbatim — and that call was
 * silently dropped. These tests pin the fallback: an unknown block that
 * carries tool-call fields still surfaces the call (loudly in dev), while
 * ordinary content blocks and the four known kinds behave exactly as before.
 */
describe('chat-stream-delta unknown array block type', () => {
  const originalDev = globals.__DEV__;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    globals.__DEV__ = originalDev;
    warnSpy.mockRestore();
  });

  test('an unknown block type carrying a name still surfaces the tool call', () => {
    globals.__DEV__ = true;
    const acc = createChatStreamAcc();
    const result = interpretChatStreamChunk(
      { choices: [{ delta: { content: [{ type: 'mcp_tool_use', name: 'read_file' }] } }] },
      acc,
    );
    expect(result.toolCalls).toEqual([{ name: 'read_file', status: 'running' }]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/mcp_tool_use/);
  });

  test('an unknown block type carrying function fields still surfaces the tool call', () => {
    globals.__DEV__ = true;
    const acc = createChatStreamAcc();
    const result = interpretChatStreamChunk(
      {
        choices: [
          { delta: { content: [{ type: 'agentic_tool', function: { name: 'web_search' } }] } },
        ],
      },
      acc,
    );
    expect(result.toolCalls).toEqual([{ name: 'web_search', status: 'running' }]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('an unknown block with no tool fields stays silent and emits nothing', () => {
    globals.__DEV__ = true;
    const acc = createChatStreamAcc();
    const result = interpretChatStreamChunk(
      { choices: [{ delta: { content: [{ type: 'text', text: 'Hi' }] } }] },
      acc,
    );
    expect(result.toolCalls).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('the four known block types extract with no warning', () => {
    globals.__DEV__ = true;
    const acc = createChatStreamAcc();
    const result = interpretChatStreamChunk(
      {
        choices: [
          {
            delta: {
              content: [
                { type: 'tool_use', name: 'a' },
                { type: 'tool_call', name: 'b' },
                { type: 'function_call', name: 'c' },
                { type: 'tool', name: 'd' },
              ],
            },
          },
        ],
      },
      acc,
    );
    expect(result.toolCalls.map((call) => call.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('the fallback warns loudly in dev and stays silent in production', () => {
    const acc = createChatStreamAcc();
    const chunk = {
      choices: [{ delta: { content: [{ type: 'future_tool', name: 'grep' }] } }],
    };
    globals.__DEV__ = false;
    expect(interpretChatStreamChunk(chunk, acc).toolCalls).toEqual([
      { name: 'grep', status: 'running' },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
    globals.__DEV__ = true;
    expect(interpretChatStreamChunk(chunk, acc).toolCalls).toEqual([
      { name: 'grep', status: 'running' },
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
