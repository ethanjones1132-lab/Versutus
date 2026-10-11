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
  test('reaches device.revoke with the typed id and never calls device.info', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const result = await executeGatewaySlashCommand('/device revoke dev-1', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('device.revoke', { deviceId: 'dev-1' });
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
      executeGatewaySlashCommand('/device revoke dev-1', {
        hello: null,
        gatewayRequest,
        runAgentCommand: jest.fn(),
      }),
    ).rejects.toThrow(/no device registry REST/);
    expect(gatewayRequest).toHaveBeenCalledWith('device.revoke', { deviceId: 'dev-1' });
    expect(gatewayRequest).not.toHaveBeenCalledWith('device.info', expect.anything());
  });

  test('a bare /device revoke asks for the device id and calls nothing', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/device revoke', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(result.text).toBe('Usage: /device revoke <device-id>');
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  test('a snapshot blocking only the /device info entry does not block a served revoke', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const result = await executeGatewaySlashCommand('/device revoke x', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      methods: {
        device: { available: false, reason: 'not dispatched by this gateway' },
        'device-revoke': { available: true },
      },
    });
    expect(gatewayRequest).toHaveBeenCalledWith('device.revoke', { deviceId: 'x' });
    expect(result.text).toContain('Revoke device: complete');
  });

  test('a snapshot blocking device-revoke blocks /device revoke even when /device info is served', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/device revoke x', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      methods: {
        device: { available: true },
        'device-revoke': { available: false, reason: 'not dispatched by this gateway' },
      },
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('Use /help to see what is.');
  });

  test('a snapshot blocking the /device info entry still blocks /device info', async () => {
    const gatewayRequest = jest.fn();
    const result = await executeGatewaySlashCommand('/device info', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
      methods: { device: { available: false, reason: 'not dispatched by this gateway' } },
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(result.text).toContain('/device is not available on this gateway');
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

  test('/device repair reads the paired-devices registry instead of device.repair', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ devices: [{ deviceId: 'dev-1', role: 'owner', scopes: [], issuedAtMs: 0, revoked: false }] });
    const result = await executeGatewaySlashCommand('/device repair', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('device.list', {});
    expect(gatewayRequest).not.toHaveBeenCalledWith('device.repair', expect.anything());
    expect(gatewayRequest).not.toHaveBeenCalledWith('device.revoke', expect.anything());
    expect(gatewayRequest).not.toHaveBeenCalledWith('device.info', expect.anything());
    expect(result.text).toContain('dev-1');
    expect(result.title).toBe('/device repair');
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
    expect(result.text).toContain('device.list');
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