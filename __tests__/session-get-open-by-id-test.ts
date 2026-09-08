import {
  normalizeSessionIdInput,
  openSessionById,
  openSessionByIdFailureText,
} from '@/lib/gateway/session-open-by-id';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readSheet(): string {
  return readSource(['src', 'components', 'chat', 'thread-config-sheet.tsx']);
}

function readChatScreen(): string {
  return readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
}

// An operator holding an exact session id (from the spend glance,
// `/session usage`, or another device) can open that thread without paging
// the windowed `sessions.list`: the sheet reads `session.get` first and the
// existing row switch runs only after the read resolves.
describe('open session by exact id', () => {
  test('pasted ids are trimmed before the read', () => {
    expect(normalizeSessionIdInput('  ses_1\n')).toBe('ses_1');
  });

  test('an empty id fails without firing a request', async () => {
    const request = jest.fn(async () => ({}));
    const result = await openSessionById(request, '   ');
    expect(result).toEqual({ ok: false, error: 'Enter a session id' });
    expect(request).not.toHaveBeenCalled();
  });

  test('the read goes out as session.get with the trimmed id', async () => {
    const request = jest.fn(async () => ({ id: 'ses_1' }));
    const result = await openSessionById(request, '  ses_1 ');
    expect(result).toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('session.get', { sessionId: 'ses_1' });
  });

  test('a rejected read stays put with the gateway message', async () => {
    const request = jest.fn(async () => {
      throw new Error('Session not found: ses_9');
    });
    const result = await openSessionById(request, 'ses_9');
    expect(result).toEqual({ ok: false, error: 'Session not found: ses_9' });
  });

  test('the failure copy names the typed id', () => {
    expect(openSessionByIdFailureText('ses_9', 'Session not found: ses_9')).toBe(
      'Session ses_9 could not be opened: Session not found: ses_9',
    );
  });

  test('the sessions section owns an Open-by-id id field', () => {
    expect(readSheet()).toContain('accessibilityLabel="Session id"');
  });

  test('the Open button announces its in-flight read', () => {
    const src = readSheet();
    expect(src).toContain("label={opening ? 'Opening…' : 'Open'}");
    expect(src).toContain('busy={opening}');
  });

  test('the section switches only after the read resolves', () => {
    const src = readSheet();
    const submitIdx = src.indexOf('const submitOpenById');
    expect(submitIdx).toBeGreaterThan(-1);
    const submit = src.slice(submitIdx, submitIdx + 1200);
    expect(submit).toContain('await reader(id)');
    expect(submit).toContain('if (result.ok)');
    expect(submit).toContain('onSelect?.(id)');
  });

  test('a failed read names the miss inline and never switches', () => {
    const src = readSheet();
    expect(src).toContain('openSessionByIdFailureText(id, result.error)');
    const submitIdx = src.indexOf('const submitOpenById');
    const submit = src.slice(submitIdx, submitIdx + 1200);
    // The only onSelect in the submit path sits inside the ok branch.
    expect(submit.indexOf('onSelect?.(id)') > submit.indexOf('if (result.ok)')).toBe(true);
  });

  test('the row hides where no gateway read exists', () => {
    const src = readSheet();
    expect(src).toContain('{onOpenById ? (');
  });

  test('the chat screen reads session.get through the live gateway request', () => {
    const src = readChatScreen();
    expect(src).toContain('openSessionById(gatewayRequest, sessionId)');
    expect(src).toContain('onOpenSessionById={handleOpenSessionById}');
  });

  test('row switch, delete, create, and search stay untouched', () => {
    const src = readSheet();
    expect(src).toContain('onSelect?.(item.id)');
    expect(src).toContain('onDeleteSession?.(deleteCandidate.id)');
    expect(src).toContain('onNewSession?.(sessionCreateTitle(nameDraft))');
    expect(src).toContain('accessibilityLabel="Search sessions"');
  });

  test('the slash path still answers /session get', () => {
    const slash = readSource(['src', 'lib', 'gateway', 'slash-commands.ts']);
    expect(slash).toContain("gatewayRequest('session.get', { sessionId: id })");
  });
});
