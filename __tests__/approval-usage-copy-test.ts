import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';
import { findConfirmableSlash } from '@/lib/gateway/command-match';

/**
 * Bare `/approval` renders `Usage: /approval ${action} <id>` with action read
 * from an empty arg, so the operator sees "Usage: /approval  <id>" — a blank
 * action with a double space, naming neither approve nor deny. The usage line
 * must name both actions, and a blank or unknown action must never fall
 * through to the method ternary, which would silently DENY an approval.
 */
describe('/approval bare usage names approve and deny', () => {
  test('a bare /approval answers with the combined usage and no RPC', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const result = await executeGatewaySlashCommand('/approval', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toBe('Usage: /approval approve <id> | deny <id>');
    expect(result.text).toContain('approve');
    expect(result.text).toContain('deny');
    expect(result.text).not.toContain('  <id>');
    expect(result.title).toBe('/approval');
  });

  test('/approval <id> with a blank action never silently denies', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const result = await executeGatewaySlashCommand('/approval ap-1', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(gatewayRequest).not.toHaveBeenCalledWith('approval.deny', expect.anything());
    expect(result.text).toBe('Usage: /approval approve <id> | deny <id>');
  });

  test('an unknown action with an id answers usage instead of falling through to deny', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const result = await executeGatewaySlashCommand('/approval maybe ap-1', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toBe('Usage: /approval approve <id> | deny <id>');
  });

  test('/approval approve <id> keeps calling approval.approve', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ id: 'ap-1', status: 'approved' });
    const result = await executeGatewaySlashCommand('/approval approve ap-1', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('approval.approve', { id: 'ap-1' });
    expect(gatewayRequest).not.toHaveBeenCalledWith('approval.deny', expect.anything());
    expect(result.text).toContain('Approval approve for ap-1');
    expect(result.title).toBe('/approval approve ap-1');
  });

  test('/approval deny <id> keeps calling approval.deny', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ id: 'ap-2', status: 'denied' });
    const result = await executeGatewaySlashCommand('/approval deny ap-2', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('approval.deny', { id: 'ap-2' });
    expect(gatewayRequest).not.toHaveBeenCalledWith('approval.approve', expect.anything());
    expect(result.text).toContain('Approval deny for ap-2');
    expect(result.title).toBe('/approval deny ap-2');
  });

  test('the composer still matches both working forms as danger write for the confirmation sheet', () => {
    const approve = findConfirmableSlash('/approval approve ap-1');
    expect(approve).not.toBeUndefined();
    expect(approve?.danger).toBe('write');
    expect(approve?.slash).toBe('/approval approve');
    const deny = findConfirmableSlash('/approval deny ap-2');
    expect(deny).not.toBeUndefined();
    expect(deny?.danger).toBe('write');
    expect(deny?.slash).toBe('/approval deny');
  });
});