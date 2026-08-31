import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

describe('/bots lists the roster in the bubble text, not only in Raw', () => {
  test('/bots lists bot rows with their routing state as the bubble text', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      bots: [
        { id: 'relay', displayName: 'relay', routable: true },
        { id: 'rook', displayName: 'rook', routable: false, routingIssue: 'listen_key_missing' },
      ],
    });
    const result = await executeGatewaySlashCommand('/bots', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('bots.list', {});
    expect(result.title).toBe('/bots');
    expect(result.text).toContain('Bots: 2');
    expect(result.text).toContain('- relay (routable: true)');
    expect(result.text).toContain('rook (routable: false, routingIssue: listen_key_missing)');
    expect(result.raw).toContain('"bots"');
  });

  test('a data-keyed roster payload renders rows too', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      data: [{ id: 'anvil', displayName: 'anvil', routable: false, routingIssue: 'multiplex_disabled' }],
    });
    const result = await executeGatewaySlashCommand('/bots', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('bots.list', {});
    expect(result.text).toContain('Bots: 1');
    expect(result.text).toContain('- anvil (routable: false, routingIssue: multiplex_disabled)');
  });

  test('an empty roster reports none instead of a bare count', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ bots: [] });
    const result = await executeGatewaySlashCommand('/bots', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toBe('Bots: none reported');
  });

  test('a roster over ten bots shows the count and the first ten rows', async () => {
    const bots = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, displayName: `bot-${i}`, routable: true }));
    const gatewayRequest = jest.fn().mockResolvedValue({ bots });
    const result = await executeGatewaySlashCommand('/bots', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toContain('Bots: 12');
    expect(result.text).toContain('- bot-0 (routable: true)');
    expect(result.text).toContain('- bot-9 (routable: true)');
    expect(result.text).not.toContain('bot-10');
  });

  test('Raw stays byte-identical for a resolved roster', async () => {
    const payload = { bots: [{ id: 'relay', displayName: 'relay', routable: true }] };
    const gatewayRequest = jest.fn().mockResolvedValue(payload);
    const result = await executeGatewaySlashCommand('/bots', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.raw).toBe(JSON.stringify(payload, null, 2));
  });
});