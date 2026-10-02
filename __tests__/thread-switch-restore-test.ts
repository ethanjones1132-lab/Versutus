import {
  THREAD_SWITCH_BOUND_MS,
  threadSwitchFailureText,
  validateThreadSwitch,
} from '@/lib/gateway/thread-switch';

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

/** A failure carrying the gate's own code, as `rpcRequest` throws it. */
function refusal(message: string, code?: string): Error & { code?: string } {
  return Object.assign(new Error(message), code ? { code } : {});
}

describe('tap validates the thread through session.restore before pinning', () => {
  test('a resolving read lets the switch proceed', async () => {
    const request = jest.fn().mockResolvedValue({ sessionId: 's-42' });
    await expect(validateThreadSwitch(request, 's-42')).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith('session.restore', { sessionId: 's-42' }, { timeoutMs: THREAD_SWITCH_BOUND_MS });
  });

  test('a scoped read asking for a session the gate cannot find blocks the switch', async () => {
    const request = jest.fn().mockRejectedValue(refusal('Session not found: s-999', 'unknown_session'));
    const validation = await validateThreadSwitch(request, 's-999', { backendId: 'hermes-local' });
    expect(validation).toEqual({ ok: false, error: 'Session not found: s-999', refreshList: true });
    expect(request).toHaveBeenCalledWith('session.restore', { sessionId: 's-999', backendId: 'hermes-local' }, { timeoutMs: THREAD_SWITCH_BOUND_MS });
  });

  test('a rejected read with a non-Error carries its string form', async () => {
    const validation = await validateThreadSwitch(
      jest.fn().mockRejectedValue('Session not found: s-1'),
      's-1',
      { backendId: 'hermes-local' },
    );
    expect(validation).toEqual({ ok: false, error: 'Session not found: s-1', refreshList: true });
  });

  test('no dispatched restore keeps today instant switch', async () => {
    await expect(validateThreadSwitch(undefined, 's-42')).resolves.toEqual({ ok: true });
  });

  test('the failure names the session exactly the slash path does', () => {
    expect(threadSwitchFailureText('s-999', 'Session not found')).toBe(
      'Session s-999 could not be restored: Session not found',
    );
  });
});

describe('only a definite miss may refuse the tap', () => {
  test('a read that times out lets the switch proceed', async () => {
    // The operator saw a red card for a session that was perfectly healthy: the
    // Gate resolved the lookup against the wrong environment, or the host was
    // slow, and every failure read the same. The history read that follows
    // names whatever really happened — with the thread in place.
    const request = jest.fn().mockRejectedValue(new Error('Request timed out: POST /v1/capabilities/rpc'));
    await expect(validateThreadSwitch(request, 's-1', { backendId: 'hermes-local' })).resolves.toEqual({ ok: true });
  });

  test('a 5xx lets the switch proceed', async () => {
    const request = jest.fn().mockRejectedValue(
      Object.assign(new Error('hermes: state database is locked'), { status: 503, code: 'backend_error' }),
    );
    await expect(validateThreadSwitch(request, 's-1', { backendId: 'hermes-local' })).resolves.toEqual({ ok: true });
  });

  test('an unreachable gateway lets the switch proceed', async () => {
    const request = jest.fn().mockRejectedValue(new Error('fetch failed: network error'));
    await expect(validateThreadSwitch(request, 's-1', { botId: 'default' })).resolves.toEqual({ ok: true });
  });

  test('a request that throws before it returns a promise is a failed read, not an exception out of the tap', async () => {
    const request = () => {
      throw new Error('socket closed');
    };
    await expect(validateThreadSwitch(request as never, 'api_1', { backendId: 'hermes-local' })).resolves.toEqual({ ok: true });
  });

  test('a read that never settles lets the switch proceed rather than hang the tap', async () => {
    // A wedged host looks exactly like this from the phone: the promise simply
    // never comes back. The bound is what turns it into a switch.
    const request = jest.fn(() => new Promise(() => {}));
    await expect(validateThreadSwitch(request, 's-1', { backendId: 'hermes-local' }, 5)).resolves.toEqual({
      ok: true,
    });
  });

  test('a read that fails AFTER the bound is not heard, and does not escape', async () => {
    // The bound has already answered, so the late refusal has nowhere to go —
    // and must not become an unhandled rejection on the way out.
    let fail!: (error: unknown) => void;
    const pending = new Promise((_resolve, reject) => { fail = reject; });
    const request = jest.fn(() => pending);
    await expect(validateThreadSwitch(request, 's-1', { backendId: 'hermes-local' }, 5)).resolves.toEqual({
      ok: true,
    });
    fail(new Error('hermes: state database is locked'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test('the validation is bounded, and the bound is the one a tap can wait for', async () => {
    expect(THREAD_SWITCH_BOUND_MS).toBe(8000);
  });

  test('an UNSCOPED "not found" is not believed: it only proves the wrong place was asked', async () => {
    // This is the failure the whole path exists to survive — the message said
    // "not found" because the read went to an environment that never held the
    // session. Refusing on it is what made in-app sessions unopenable.
    const request = jest.fn().mockRejectedValue(new Error('Session not found: api_1'));
    await expect(validateThreadSwitch(request, 'api_1')).resolves.toEqual({ ok: true });
  });

  test('the gate\'s own code is believed even unscoped, because it named the miss', async () => {
    const request = jest.fn().mockRejectedValue(refusal('Session not found: api_1', 'unknown_session'));
    await expect(validateThreadSwitch(request, 'api_1')).resolves.toEqual({
      ok: false,
      error: 'Session not found: api_1',
      refreshList: true,
    });
  });

  test('a scoped read is sent with the Bot when one is selected', async () => {
    // A Bot names its own environment, so it travels alone.
    const request = jest.fn().mockResolvedValue({});
    await validateThreadSwitch(request, 'api_1', { backendId: 'claude-local', botId: 'default' });
    expect(request).toHaveBeenCalledWith('session.restore', { sessionId: 'api_1', bot: 'default' }, { timeoutMs: THREAD_SWITCH_BOUND_MS });
  });
});

describe('provider selectSession keeps the slash discipline', () => {
  const provider = () =>
    readSource('src', 'context', 'gateway-provider.tsx');

  function selectSessionBody(src: string): string {
    const start = src.indexOf('const selectSession = useCallback(');
    expect(start).toBeGreaterThanOrEqual(0);
    return src.slice(start, start + 4000);
  }

  test('the tap reads session.restore through the shared validator', () => {
    const body = selectSessionBody(provider());
    expect(body).toContain('validateThreadSwitch');
    expect(body).toContain('session.restore');
  });

  test('the validation read lands ahead of the pin and the history reload', () => {
    const body = selectSessionBody(provider());
    const validationAt = body.indexOf('validateThreadSwitch');
    const pinAt = body.indexOf('pinLiveSession');
    const reloadAt = body.indexOf('reloadHistoryFor');
    expect(validationAt).toBeGreaterThanOrEqual(0);
    expect(pinAt).toBeGreaterThan(validationAt);
    expect(reloadAt).toBeGreaterThan(validationAt);
  });

  test('a rejected validation names the failure and returns before pinning', () => {
    const body = selectSessionBody(provider());
    expect(body).toContain('threadSwitchFailureText');
    expect(body).toContain('setLastError');
    const failureAt = body.indexOf('threadSwitchFailureText');
    const pinAt = body.indexOf('pinLiveSession');
    // The early return sits between the named failure and the pin.
    const returnAt = body.indexOf('return;', failureAt);
    expect(returnAt).toBeGreaterThan(failureAt);
    expect(returnAt).toBeLessThan(pinAt);
  });

  test('the read is scoped to the thread\'s own environment and Bot', () => {
    // Unscoped, the Gate resolved the lookup against whichever environment
    // sorted first and reported a healthy in-app session as not found.
    const body = selectSessionBody(provider());
    expect(body).toContain('selectedBackendIdRef.current');
    expect(body).toContain('selectedBotIdRef.current');
  });

  test('a definite miss re-reads the session list, so the stale row goes away', () => {
    const body = selectSessionBody(provider());
    expect(body).toContain('validation.refreshList');
    expect(body).toContain('readSessionList');
  });

  test('the delete flow, search filter, and history reload are untouched', () => {
    const src = provider();
    expect(src).toContain('const deleteSessionById = useCallback(');
    expect(src).toContain('await client.deleteSession(sessionId)');
    expect(src).toContain('const reloadHistoryFor = useCallback(');
    const sheet = readSource('src', 'components', 'chat', 'thread-config-sheet.tsx');
    expect(sheet).toContain('onSelectSession');
    expect(sheet).toContain('visibleSessions');
  });
});
