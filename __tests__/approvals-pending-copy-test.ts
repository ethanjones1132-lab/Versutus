import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

describe('/approvals pending copy', () => {
  test('a pending payload renders count and named rows in the bubble text', async () => {
    const payload = {
      pending: [
        { approvalId: 'a1f2', type: 'tool', request: { name: 'read_file' }, decision: 'pending' },
        { approvalId: 'b3c4', type: 'exec', decision: 'pending' },
      ],
    };
    const gatewayRequest = jest.fn().mockResolvedValue(payload);
    const result = await executeGatewaySlashCommand('/approvals pending', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('approvals.pending', {});
    expect(result.text).toContain('Pending approvals: 2');
    expect(result.text).toContain('- a1f2 (type: tool, decision: pending)');
    expect(result.text).toContain('- b3c4 (type: exec, decision: pending)');
    expect(result.title).toBe('/approvals pending');
    expect(result.raw).toBe(JSON.stringify(payload, null, 2));
  });

  test('a pending payload under the requests key renders rows the same way', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      requests: [{ id: 'r9', status: 'pending', description: 'Approve tool call' }],
    });
    const result = await executeGatewaySlashCommand('/approvals pending', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toContain('Pending approvals: 1');
    expect(result.text).toContain('- r9 (status: pending)');
  });

  test('an empty pending list renders an honest empty copy', async () => {
    const payload = { pending: [] };
    const gatewayRequest = jest.fn().mockResolvedValue(payload);
    const result = await executeGatewaySlashCommand('/approvals pending', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toBe('Pending approvals: none reported');
    expect(result.raw).toBe(JSON.stringify(payload, null, 2));
  });

  test('a rejecting approvals.pending RPC names the failure, not the bare title', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('approvals.pending is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/approvals pending', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toContain('Pending approvals could not be read');
    expect(result.text).toContain('approvals.pending is not supported');
    expect(result.text).not.toBe('Pending approvals');
  });

  test('a rejecting approvals.pending RPC with a bare error still carries the METHOD_GUIDANCE next step', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('boom'));
    const result = await executeGatewaySlashCommand('/approvals pending', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toContain('Pending approvals could not be read');
    expect(result.text).toContain('Approve from the app when a run requests it');
  });

  test('bare /approvals keeps the policy view with counts, not the pending rows', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({
      pending: [{ approvalId: 'a1f2', type: 'tool', decision: 'pending' }],
      policy: 'manual',
    });
    const result = await executeGatewaySlashCommand('/approvals', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('exec.approvals.get', {});
    expect(result.text).toContain('Approvals');
    expect(result.text).toContain('Pending: 1');
    expect(result.text).toContain('Policy: manual');
    expect(result.text).not.toContain('- a1f2');
  });
});