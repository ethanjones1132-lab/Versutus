import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

/**
 * `/device`, `/device repair`, `/talk catalog|config|mode`, `/voicewake`
 * and `/logs <level>` catch a rejected RPC into `{ error }` and print the
 * success title ("Device info", "Device token repair attempted", "Talk
 * catalog", "VoiceWake status", "error logs") as if the read happened —
 * the error sat only in Raw. A caught rejection must carry the failure
 * into the bubble text, with the METHOD_GUIDANCE next step when the
 * method has an entry (device.info / device.repair / talk.catalog /
 * voicewake.status / logs.tail) and the error does not already name it;
 * resolved reads keep today's title and Raw byte-identical.
 */
describe('/device, /talk, /voicewake and /logs read honesty', () => {
  test('a rejecting device.info RPC names the failure, not "Device info"', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('device.info is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/device', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('device.info', {});
    expect(result.text).toContain('Device info could not be read');
    expect(result.text).toContain('device.info is not supported');
    expect(result.text).toContain('Versutus devices pair via signed access requests');
    expect(result.text).not.toBe('Device info');
    expect(result.raw).not.toBe('{}');
  });

  test('a resolving device.info RPC keeps today\'s title and Raw', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ serial: 'A1' });
    const result = await executeGatewaySlashCommand('/device', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('device.info', {});
    expect(result.text).toBe('Device info');
    expect(result.raw).toBe('{\n  "serial": "A1"\n}');
  });

  test('a rejecting device.repair RPC names the failure, not "Device token repair attempted"', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('device.repair is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/device repair', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('device.repair', {});
    expect(result.text).toContain('Device token repair failed');
    expect(result.text).toContain('device.repair is not supported');
    expect(result.text).toContain('Versutus devices pair via signed access requests');
    expect(result.text).not.toBe('Device token repair attempted');
    expect(result.raw).not.toBe('{}');
  });

  test('a resolving device.repair RPC keeps today\'s title and Raw', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    const result = await executeGatewaySlashCommand('/device repair', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('device.repair', {});
    expect(result.text).toBe('Device token repair attempted');
    expect(result.raw).toBe('{\n  "ok": true\n}');
  });

  test('a rejecting talk.catalog RPC names the failure with the voice guidance', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('talk.catalog is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/talk catalog', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('talk.catalog', {});
    expect(result.text).toContain('Talk catalog could not be read');
    expect(result.text).toContain('talk.catalog is not supported');
    expect(result.text).toContain('Voice is host-side; the API server exposes no voice REST.');
    expect(result.text).not.toBe('Talk catalog');
    expect(result.raw).not.toBe('{}');
  });

  test('a rejecting talk.config RPC with a bare error is not padded with guidance it has no entry for', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('boom'));
    const result = await executeGatewaySlashCommand('/talk config', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('talk.config', {});
    expect(result.text).toBe('Talk config could not be read: Error: boom');
  });

  test('a resolving talk.mode RPC keeps today\'s title and Raw', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ mode: 'manual' });
    const result = await executeGatewaySlashCommand('/talk mode', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('talk.mode', {});
    expect(result.text).toBe('Talk mode');
    expect(result.raw).toBe('{\n  "mode": "manual"\n}');
  });

  test('a rejecting voicewake.status RPC names the failure, not "VoiceWake status"', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('voicewake.status is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/voicewake', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('voicewake.status', {});
    expect(result.text).toContain('VoiceWake status could not be read');
    expect(result.text).toContain('voicewake.status is not supported');
    expect(result.text).toContain('Voice is host-side; the API server exposes no voice REST.');
    expect(result.text).not.toBe('VoiceWake status');
    expect(result.raw).not.toBe('{}');
  });

  test('a resolving voicewake.status RPC keeps today\'s title and Raw', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ enabled: false });
    const result = await executeGatewaySlashCommand('/voicewake', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('voicewake.status', {});
    expect(result.text).toBe('VoiceWake status');
    expect(result.raw).toBe('{\n  "enabled": false\n}');
  });

  test('a rejecting logs.tail RPC names the failure with the host-side guidance', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('logs.tail is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/logs error', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('logs.tail', { level: 'error', limit: 20 });
    expect(result.text).toContain('error logs could not be read');
    expect(result.text).toContain('logs.tail is not supported');
    expect(result.text).toContain('Gateway logs are host-side');
    expect(result.text).not.toBe('error logs');
    expect(result.raw).not.toBe('{}');
  });

  test('a rejecting logs.tail RPC for warn still clamps the limit and names the failure', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('logs.tail is not supported by this gateway.'));
    const result = await executeGatewaySlashCommand('/logs warn 3', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('logs.tail', { level: 'warn', limit: 5 });
    expect(result.text).toContain('warn logs could not be read');
  });

  test('a resolving logs.tail RPC keeps today\'s title and Raw', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ lines: ['l1'] });
    const result = await executeGatewaySlashCommand('/logs boot', {
      hello: null,
      gatewayRequest,
      runAgentCommand: jest.fn(),
    });
    expect(gatewayRequest).toHaveBeenCalledWith('logs.tail', { level: 'boot', limit: 20 });
    expect(result.text).toBe('boot logs');
    expect(result.raw).toBe('{\n  "lines": [\n    "l1"\n  ]\n}');
  });

  test('a rejecting /device revoke still forwards to the registry dispatch, never a read title', async () => {
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
});