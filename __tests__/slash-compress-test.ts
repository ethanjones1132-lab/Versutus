import { getSlashCommandSuggestions, executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';
import type { ChatMessage, GatewayHelloOk } from '@/lib/gateway/types';

const HELLO: GatewayHelloOk = {
  type: 'hello-ok',
  protocol: 3,
  server: { version: '0.5.2', connId: 'c1' },
};

function messages(spec: Array<ChatMessage['role']>): ChatMessage[] {
  return spec.map((role, index) => ({
    id: `${role}-${index}`,
    role,
    text: `${role} ${index}`,
    timestamp: 1_700_000_000_000 + index,
  }));
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    hello: HELLO,
    gatewayRequest: jest.fn().mockResolvedValue({ surprise: true }),
    runAgentCommand: jest.fn(),
    messages: messages(['user', 'assistant', 'user', 'system']),
    ...overrides,
  };
}

describe('/compress is local conversation-size, never a wire call', () => {
  test('reports conversation size from the live transcript without calling gatewayRequest', async () => {
    const ctx = context();
    const result = await executeGatewaySlashCommand('/compress', ctx);
    expect(result.text).toMatch(/4/);
    expect(result.text).toMatch(/user/i);
    expect(result.text).toMatch(/assistant/i);
    expect(result.title).toBe('/compress');
    expect(ctx.gatewayRequest).not.toHaveBeenCalled();
  });

  test('an empty transcript is a zero count, not an RPC', async () => {
    const ctx = context({ messages: [] });
    const result = await executeGatewaySlashCommand('/compress', ctx);
    expect(result.text).toMatch(/0/);
    expect(ctx.gatewayRequest).not.toHaveBeenCalled();
  });

  test('states that compaction is not offered over the API', async () => {
    const ctx = context();
    const result = await executeGatewaySlashCommand('/compress', ctx);
    expect(result.text).toMatch(/not.{0,20}offered over the API/i);
  });

  test('points the operator at /reset and the session selector', async () => {
    const ctx = context();
    const result = await executeGatewaySlashCommand('/compress', ctx);
    expect(result.text).toMatch(/\/reset/i);
    expect(result.text).toMatch(/session selector|select a session|new session/i);
  });
});

describe('/compress stays in the palette as a local command', () => {
  test('the palette offers /compress as a local command', () => {
    const suggestions = getSlashCommandSuggestions('/comp', null, [], {}, [], Number.POSITIVE_INFINITY);
    expect(suggestions.some((item) => item.value === '/compress')).toBe(true);
  });
});
