import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';
import { findConfirmableSlash } from '@/lib/gateway/command-match';

/**
 * `/device revoke` is advertised by the registry (dashboard.ts device-revoke,
 * danger destructive) and matches the composer's confirmation sheet, but
 * runApprovalsDevicesCommand only special-cases `repair`; every other sub
 * falls to device.info, so a destructive request is answered by a read.
 * The revoke sub must forward into the registry entry so device.revoke runs,
 * the blocked snapshot answers with guidance, and honest RPC failures
 * surface instead of a "Device info" read.
 */
describe('/device revoke forwards to the registered device-revoke entry', () => {
  test('reaches device.revoke and never calls device.info', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const result = await executeGatewaySlashCommand('/device revoke', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('device.revoke', {});
    expect(gatewayRequest).not.toHaveBeenCalledWith('device.info', expect.anything());
    expect(gatewayRequest).not.toHaveBeenCalledWith('device.repair', expect.anything());
    expect(result.text).toContain('Revoke device: complete');
    expect(result.title).toBe('/device revoke');
  });

  test('a gateway with no device registry REST reports the real failure instead of a device-info read', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(
      new Error(
        'device.revoke is not supported by this gateway. Versutus devices pair via signed access requests; Hermes has no device registry REST.',
      ),
    );
    await expect(
      executeGatewaySlashCommand('/device revoke', {
        hello: null,
        gatewayRequest,
        runAgentCommand: jest.fn(),
      }),
    ).rejects.toThrow(/no device registry REST/);
    expect(gatewayRequest).toHaveBeenCalledWith('device.revoke', {});
    expect(gatewayRequest).not.toHaveBeenCalledWith('device.info', expect.anything());
  });

  test('a bare /device keeps reading device info', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ id: 'dev-1', roles: ['operator'] });
    const result = await executeGatewaySlashCommand('/device', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('device.info', {});
    expect(gatewayRequest).not.toHaveBeenCalledWith('device.revoke', expect.anything());
    expect(result.text).toContain('Device info');
    expect(result.title).toBe('/device');
  });

  test('/device repair keeps calling device.repair', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const result = await executeGatewaySlashCommand('/device repair', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('device.repair', {});
    expect(gatewayRequest).not.toHaveBeenCalledWith('device.revoke', expect.anything());
    expect(gatewayRequest).not.toHaveBeenCalledWith('device.info', expect.anything());
    expect(result.text).toContain('Device token repair attempted');
  });

  test('a snapshot blocking the device family answers with guidance before any RPC', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/device revoke', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      methods: {
        device: { available: false, reason: 'not dispatched by this gateway' },
        'device-revoke': { available: false, reason: 'not dispatched by this gateway' },
      },
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('no device registry REST');
    expect(result.text).toContain('Use /help to see what is.');
    expect(result.text).not.toContain('Device info');
  });

  test('the composer still matches /device revoke as danger destructive for the confirmation sheet', () => {
    const match = findConfirmableSlash('/device revoke');
    expect(match).not.toBeUndefined();
    expect(match?.danger).toBe('destructive');
    expect(match?.slash).toBe('/device revoke');
  });
});