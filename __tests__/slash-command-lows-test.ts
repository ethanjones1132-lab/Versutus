import { executeGatewaySlashCommand } from '@/lib/gateway/slash-commands';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSlashCommandsSource(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'lib', 'gateway', 'slash-commands.ts'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function testContext(gatewayRequest: jest.Mock) {
  return { hello: null, gatewayRequest, runAgentCommand: jest.fn() };
}

describe('/cron create keeps the prompt as typed', () => {
  test('quotes and runs of whitespace in the prompt survive tokenization', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    await executeGatewaySlashCommand(
      '/cron create Report | 0 9 * * * | Say "hi"  twice',
      testContext(gatewayRequest),
    );
    // The prompt used to be rebuilt from tokens, so this arrived as
    // `Say hi twice`: quotes gone and the double space collapsed.
    expect(gatewayRequest).toHaveBeenCalledWith('jobs.create', {
      name: 'Report',
      schedule: '0 9 * * *',
      prompt: 'Say "hi"  twice',
    });
  });

  test('a quoted title is still one segment, without the quote marks', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ ok: true });
    await executeGatewaySlashCommand(
      '/cron create "Nightly check" | daily | report',
      testContext(gatewayRequest),
    );
    expect(gatewayRequest).toHaveBeenCalledWith('jobs.create', {
      name: 'Nightly check',
      schedule: 'daily',
      prompt: 'report',
    });
  });
});

describe('summary reads show the failure reason', () => {
  test('a refused health read names the RPC error', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('diagnostics.full is not supported'));
    const result = await executeGatewaySlashCommand('/diagnostics', testContext(gatewayRequest));
    expect(result.text).toBe('Health checks could not be read: diagnostics.full is not supported');
  });

  test('a refused spend read names the RPC error', async () => {
    const gatewayRequest = jest.fn().mockRejectedValue(new Error('sessions.list is not supported'));
    const result = await executeGatewaySlashCommand('/usage', testContext(gatewayRequest));
    expect(result.text).toBe('Sessions could not be read: sessions.list is not supported');
  });
});

describe('empty health and status payloads are unknown, not healthy', () => {
  test('/health with no recognised field does not answer "OK"', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({});
    const result = await executeGatewaySlashCommand('/health', testContext(gatewayRequest));
    expect(result.text).toBe('Health: unknown');
  });

  test('/health still renders a recognised status', async () => {
    const gatewayRequest = jest.fn().mockResolvedValue({ status: 'degraded' });
    const result = await executeGatewaySlashCommand('/health', testContext(gatewayRequest));
    expect(result.text).toBe('Health: degraded');
  });

  test('the status summary has no invented "online" fallback', () => {
    // formatGatewayStatus is only reachable through the registry path, not
    // the /status slash branch, so pin the removed default at its source.
    expect(readSlashCommandsSource()).toContain(
      "readFirstString(server, ['status', 'state']) ?? 'unknown'",
    );
  });
});

describe('the slash dispatch keeps no dead branches', () => {
  test('the blocked check no longer excludes /run after the early return', () => {
    // `/run` returns before this check, so the exclusion could never see it.
    expect(readSlashCommandsSource()).not.toContain("commandName !== '/run'");
  });

  test('the family read has no unreachable derived-method fallback', () => {
    // Every caller of runAdvancedFamilyCommand is handled by the switch
    // above, so the derived method name never runs.
    expect(readSlashCommandsSource()).not.toContain(
      "commandName.replace('/', '').replace('-', '.') + '.list'",
    );
  });
});

describe('bare /model has one switch path', () => {
  test('the OpenClaw path never reads a catalogue whose verdict it discards', async () => {
    const methods: string[] = [];
    const gatewayRequest = jest.fn().mockImplementation(async (method: string) => {
      methods.push(method);
      if (method === 'config.get') {
        return { hash: 'h1', config: { agents: { defaults: { model: { primary: 'gateway-default' } } } } };
      }
      if (method === 'config.patch') return { ok: true, hash: 'h2' };
      throw new Error(`unexpected: ${method}`);
    });
    const result = await executeGatewaySlashCommand('/model grok-4', testContext(gatewayRequest));
    // Without setModelOverride the validation result was thrown away, so the
    // models.list read was pure waste on every OpenClaw bare switch.
    expect(methods).not.toContain('models.list');
    expect(result.text).toContain('Default model updated to grok-4');
  });

  test('the comment no longer claims the composer path is unused', () => {
    expect(readSlashCommandsSource()).not.toContain('unused in favour of the sheet');
  });
});
