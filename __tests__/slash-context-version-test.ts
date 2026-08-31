import { GATEWAY_COMMANDS } from '@/lib/gateway/dashboard';
import { METHOD_TO_ROUTE } from '@/lib/gateway/rpc-routes';
import { executeGatewaySlashCommand, getSlashCommandSuggestions } from '@/lib/gateway/slash-commands';
import type { ChatMessage, GatewayHelloOk } from '@/lib/gateway/types';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

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

describe('/version is local hello, never the wire', () => {
  test('prints activeHello.server.version and does not call gatewayRequest', async () => {
    const ctx = context();
    const result = await executeGatewaySlashCommand('/version', ctx);
    expect(result.text).toContain('0.5.2');
    expect(result.title).toBe('/version');
    expect(ctx.gatewayRequest).not.toHaveBeenCalled();
  });

  test('says so when the handshake has no version, still without RPC', async () => {
    const ctx = context({
      hello: { type: 'hello-ok', protocol: 3, server: {} },
    });
    const result = await executeGatewaySlashCommand('/version', ctx);
    expect(result.text).toMatch(/not (known|reported)/i);
    expect(result.text).not.toContain('surprise');
    expect(ctx.gatewayRequest).not.toHaveBeenCalled();
  });
});

describe('/context is local transcript counts, never context.get', () => {
  test('counts roles from the messages on the context and does not call gatewayRequest', async () => {
    const ctx = context();
    const result = await executeGatewaySlashCommand('/context', ctx);
    expect(result.text).toMatch(/4/);
    expect(result.text).toMatch(/user/i);
    expect(result.text).toMatch(/assistant/i);
    expect(result.title).toBe('/context');
    expect(ctx.gatewayRequest).not.toHaveBeenCalled();
  });

  test('an empty transcript is a zero count, not an RPC', async () => {
    const ctx = context({ messages: [] });
    const result = await executeGatewaySlashCommand('/context', ctx);
    expect(result.text).toMatch(/0/);
    expect(ctx.gatewayRequest).not.toHaveBeenCalled();
  });
});

describe('the previous 404 wire is gone', () => {
  test('METHOD_TO_ROUTE does not invent GET /v1/context or /v1/version', () => {
    expect(METHOD_TO_ROUTE['context.get']).toBeUndefined();
    expect(METHOD_TO_ROUTE['version.get']).toBeUndefined();
  });

  test('GATEWAY_COMMANDS does not dispatch context.get or version.get', () => {
    expect(GATEWAY_COMMANDS.some((command) => command.method === 'context.get')).toBe(false);
    expect(GATEWAY_COMMANDS.some((command) => command.method === 'version.get')).toBe(false);
  });

  test('the palette still offers /context and /version as local commands', () => {
    const suggestions = getSlashCommandSuggestions('/', null, [], {}, [], Number.POSITIVE_INFINITY);
    expect(suggestions.some((item) => item.value === '/context')).toBe(true);
    expect(suggestions.some((item) => item.value === '/version')).toBe(true);
  });

  test('sendChatInput hands the live transcript into /context', () => {
    const src = nodeFs
      .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
      .replace(/\r\n/g, '\n');
    const call = src.match(/executeGatewaySlashCommand\([\s\S]*?\n\s*\}\);/)?.[0];
    expect(call).toBeDefined();
    expect(call).toMatch(/hello:\s*activeHello/);
    expect(call).toMatch(/messages:\s*messagesRef\.current/);
  });
});
