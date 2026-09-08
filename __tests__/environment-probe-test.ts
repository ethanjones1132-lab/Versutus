import {
  decideEnvironmentProbe,
  environmentProbeFailureText,
  probeEnvironmentLifecycle,
} from '@/lib/gateway/environment-probe';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('decideEnvironmentProbe', () => {
  test('a backend becoming active on a reconnect is probed, not only first adoption', () => {
    // First connect: nothing probed yet, backends just landed.
    const adopted = decideEnvironmentProbe({
      backendId: 'hermes-local',
      lastProbedId: undefined,
      backendsAvailable: true,
      connected: true,
    });
    expect(adopted.probeId).toBe('hermes-local');

    // Same activation — every later render must not re-probe.
    const stillActive = decideEnvironmentProbe({
      backendId: 'hermes-local',
      lastProbedId: adopted.lastProbedId,
      backendsAvailable: true,
      connected: true,
    });
    expect(stillActive.probeId).toBeUndefined();
    expect(stillActive.lastProbedId).toBe('hermes-local');

    // Reconnect tears the manifest down. Clearing lastProbedId is how the
    // same backend is probed again when backends reappear.
    const dropped = decideEnvironmentProbe({
      backendId: 'hermes-local',
      lastProbedId: stillActive.lastProbedId,
      backendsAvailable: false,
      connected: false,
    });
    expect(dropped.probeId).toBeUndefined();
    expect(dropped.lastProbedId).toBeUndefined();

    const reconnected = decideEnvironmentProbe({
      backendId: 'hermes-local',
      lastProbedId: dropped.lastProbedId,
      backendsAvailable: true,
      connected: true,
    });
    expect(reconnected.probeId).toBe('hermes-local');
  });

  test('an explicit backend switch probes the new backend once', () => {
    const switched = decideEnvironmentProbe({
      backendId: 'claude-local',
      lastProbedId: 'hermes-local',
      backendsAvailable: true,
      connected: true,
    });
    expect(switched.probeId).toBe('claude-local');
    expect(switched.lastProbedId).toBe('claude-local');
  });

  test('nothing is probed until a backend is actually selected', () => {
    const pending = decideEnvironmentProbe({
      backendId: undefined,
      lastProbedId: undefined,
      backendsAvailable: true,
      connected: true,
    });
    expect(pending.probeId).toBeUndefined();
  });

  test('a selected backend is not probed until the gateway is connected', () => {
    const waiting = decideEnvironmentProbe({
      backendId: 'hermes-local',
      lastProbedId: undefined,
      backendsAvailable: true,
      connected: false,
    });
    expect(waiting.probeId).toBeUndefined();
    // Not marked probed either — the connected render still has to fire.
    expect(waiting.lastProbedId).toBeUndefined();
  });
});

describe('probeEnvironmentLifecycle', () => {
  test('a resolved probe calls environments.lifecycle.start and reports ok', async () => {
    const request = jest.fn().mockResolvedValue({ state: 'ready' });
    await expect(probeEnvironmentLifecycle(request, 'hermes-local')).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith('environments.lifecycle.start', { id: 'hermes-local' });
  });

  test('a rejected probe does not reject, so the connect path can ignore it', async () => {
    const request = jest.fn().mockRejectedValue(new Error('spawn failed'));
    const result = await probeEnvironmentLifecycle(request, 'hermes-local');
    expect(result).toEqual({ ok: false, error: 'spawn failed' });
    expect(request).toHaveBeenCalledWith('environments.lifecycle.start', { id: 'hermes-local' });
  });

  test('a rejected probe with a non-Error carries its string form', async () => {
    const result = await probeEnvironmentLifecycle(
      jest.fn().mockRejectedValue('environment "ghost" not found'),
      'ghost',
    );
    expect(result).toEqual({ ok: false, error: 'environment "ghost" not found' });
  });

  test('a slow probe does not delay or fail the connect path that does not await it', async () => {
    let resolveProbe: (value: unknown) => void = () => undefined;
    const request = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );

    const connect = async () => {
      void probeEnvironmentLifecycle(request, 'hermes-local');
      return 'connected';
    };

    await expect(connect()).resolves.toBe('connected');
    expect(request).toHaveBeenCalledWith('environments.lifecycle.start', { id: 'hermes-local' });
    resolveProbe({ state: 'ready' });
  });

  test('the failure names the environment exactly the slash path does', () => {
    expect(environmentProbeFailureText('hermes-local', 'spawn failed')).toBe(
      'Environment hermes-local could not be started: spawn failed',
    );
  });
});

describe('provider probes whenever a backend becomes active', () => {
  const provider = () => readSource('src', 'context', 'gateway-provider.tsx');

  function adoptBackendBody(src: string): string {
    const start = src.indexOf('Land a fresh connection on a usable backend');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = src.indexOf('const runAgentCommand = useCallback', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  test('a selected backend no longer skips the probe on reconnect', () => {
    const body = adoptBackendBody(provider());
    // The old gate: once selectedBackendId was set, every later connect
    // returned before lifecycle.start. Reconnect and an explicit switch
    // both need the probe, so that early-return cannot stand.
    expect(body).not.toMatch(/if \(selectedBackendId \|\| backends\.length === 0\) return/);
    expect(body).toContain('decideEnvironmentProbe');
    expect(body).toContain('probeEnvironmentLifecycle');
  });

  test('a rejected probe is named through lastError instead of swallowed', () => {
    const body = adoptBackendBody(provider());
    expect(body).toContain('environmentProbeFailureText');
    expect(body).toContain('setLastError');
    expect(body).not.toMatch(/lifecycle\.start[\s\S]*\.catch\(\(\) => undefined\)/);
  });

  test('the probe is fire-and-forget so a slow or failed start cannot block connect', () => {
    const body = adoptBackendBody(provider());
    expect(body).toMatch(/void probeEnvironmentLifecycle\(/);
    expect(body).not.toMatch(/await probeEnvironmentLifecycle\(/);
  });

  test('first adoption still does not tear down the thread', () => {
    // Lighter than selectBackend on purpose: clearing messages here would
    // fight the history reload the connect path is already running.
    const body = adoptBackendBody(provider());
    expect(body).not.toContain('setMessages([])');
    expect(body).toContain('void reloadHistoryFor(gateway)');
  });
});
