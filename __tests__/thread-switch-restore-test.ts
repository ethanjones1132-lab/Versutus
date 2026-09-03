import {
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

describe('tap validates the thread through session.restore before pinning', () => {
  test('a resolving read lets the switch proceed', async () => {
    const request = jest.fn().mockResolvedValue({ sessionId: 's-42' });
    await expect(validateThreadSwitch(request, 's-42')).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith('session.restore', { sessionId: 's-42' });
  });

  test('a rejecting read blocks the switch and carries the failure', async () => {
    const request = jest.fn().mockRejectedValue(new Error('Session not found'));
    const validation = await validateThreadSwitch(request, 's-999');
    expect(validation).toEqual({ ok: false, error: 'Session not found' });
    expect(request).toHaveBeenCalledWith('session.restore', { sessionId: 's-999' });
  });

  test('a rejecting read with a non-Error carries its string form', async () => {
    const validation = await validateThreadSwitch(
      jest.fn().mockRejectedValue('gone'),
      's-1',
    );
    expect(validation).toEqual({ ok: false, error: 'gone' });
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

describe('provider selectSession keeps the slash discipline', () => {
  const provider = () =>
    readSource('src', 'context', 'gateway-provider.tsx');

  function selectSessionBody(src: string): string {
    const start = src.indexOf('const selectSession = useCallback(');
    expect(start).toBeGreaterThanOrEqual(0);
    return src.slice(start, start + 2000);
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
