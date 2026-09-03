import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

describe('/session fork honesty', () => {
  test('/session fork without an id answers with the fork usage, never an RPC', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/session fork', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('Usage: /session fork <session-id>');
  });

  test('a rejecting session.fork RPC names the failure, not a success copy', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('session.fork is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/session fork s-7', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.fork', { sessionId: 's-7' });
    expect(result.text).not.toContain('Session fork requested');
    expect(result.text).toContain('could not be run');
    expect(result.text).toContain('session.fork is not supported');
  });

  test('a rejecting session.fork RPC with a bare error still carries the METHOD_GUIDANCE next step', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('boom'));
    const result = await executeGatewaySlashCommand('/session fork s-7', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).not.toContain('Session fork requested');
    expect(result.text).toContain('No remote fork endpoint');
  });

  test('a resolving session.fork RPC still prints the success copy', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const result = await executeGatewaySlashCommand('/session fork s-7', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('session.fork', { sessionId: 's-7' });
    expect(result.text).toContain('Session fork requested');
  });

  test('a fresh snapshot blocking session-fork answers with the METHOD_GUIDANCE next step, not the generic reason', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/session fork s-7', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      methods: { 'session-fork': { available: false, reason: 'not dispatched by this gateway' } },
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('No remote fork endpoint');
    expect(result.text).toContain('Use /help to see what is.');
    expect(result.text).not.toContain('not dispatched by this gateway');
  });

  test('an unknown /session subcommand still answers with the usage line naming fork <id>', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/session frobnicate', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('Usage: /session');
    expect(result.text).toContain('fork <id>');
  });
});
