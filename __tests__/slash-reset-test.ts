import { executeGatewaySlashCommand, getSlashCommandSuggestions } from '@/lib/gateway/slash-commands';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    hello: null,
    gatewayRequest: jest.fn().mockResolvedValue({ surprise: true }),
    runAgentCommand: jest.fn(),
    resetConversation: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('/reset clears the thread locally', () => {
  test('invokes resetConversation and never hits the wire', async () => {
    const ctx = context();
    const result = await executeGatewaySlashCommand('/reset', ctx);
    expect(ctx.resetConversation).toHaveBeenCalledTimes(1);
    expect(ctx.gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toMatch(/new session/i);
    expect(result.title).toBe('/reset');
  });

  test('says so when no reset callback is wired, still without RPC', async () => {
    const ctx = context({ resetConversation: undefined });
    const result = await executeGatewaySlashCommand('/reset', ctx);
    expect(result.text).toMatch(/cannot reset/i);
    expect(ctx.gatewayRequest).not.toHaveBeenCalled();
  });

  test('the palette offers /reset as a local command', () => {
    const suggestions = getSlashCommandSuggestions('/res', null, [], {}, [], Number.POSITIVE_INFINITY);
    expect(suggestions.some((item) => item.value === '/reset')).toBe(true);
  });

  test('sendChatInput wires resetConversation to the same createNewSession the sheet uses', () => {
    const src = nodeFs
      .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(src).toMatch(/resetConversation:\s*\(\)\s*=>\s*createNewSessionRef\.current\(\)/);
    expect(src).toMatch(/createNewSessionRef\.current = createNewSession/);
  });
});
