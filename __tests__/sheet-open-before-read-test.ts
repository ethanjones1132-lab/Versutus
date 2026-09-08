import { beginSessionListRead, applySessionListRead } from '@/lib/gateway/session-list';
import type { SessionListState } from '@/lib/gateway/session-list';

declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as { readFileSync(p: string, e: string): string };
const readSource = (...parts: string[]): string =>
  nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');

type S = SessionListState<{ id: string }>;
const EMPTY: S = { sessions: [], loaded: false, failed: false };

describe('beginSessionListRead', () => {
  test('a first open shows nothing loaded and no failure — that is "reading", not "none"', () => {
    expect(beginSessionListRead(EMPTY)).toEqual({ sessions: [], loaded: false, failed: false });
  });

  test('a re-open keeps the last good list on screen while the re-read runs', () => {
    const loaded: S = { sessions: [{ id: 'a' }], loaded: true, failed: false };
    expect(beginSessionListRead(loaded)).toEqual({ sessions: [{ id: 'a' }], loaded: true, failed: false });
  });

  test('a new attempt drops the PREVIOUS attempt failure', () => {
    // Reporting "Sessions could not be read" before the new read has answered
    // is reporting the past as the present.
    const failed: S = { sessions: [], loaded: false, failed: true };
    expect(beginSessionListRead(failed).failed).toBe(false);
    const staleAfterLoad: S = { sessions: [{ id: 'a' }], loaded: true, failed: true };
    expect(beginSessionListRead(staleAfterLoad)).toEqual({ sessions: [{ id: 'a' }], loaded: true, failed: false });
  });

  test('it does not invent a loaded state — an unloaded list stays unloaded', () => {
    expect(beginSessionListRead(EMPTY).loaded).toBe(false);
  });

  test('a failure after the new attempt still reports, so the fix does not hide errors', () => {
    const afterBegin = beginSessionListRead(EMPTY);
    expect(applySessionListRead(afterBegin, { ok: false }).failed).toBe(true);
  });
});

describe('sheet openers show the sheet before reading', () => {
  const provider = readSource('src', 'context', 'gateway-provider.tsx');

  test('openSessionSelector sets visible before it awaits the read', () => {
    const fn = provider.match(/const openSessionSelector = useCallback\([\s\S]*?\n  \}, \[\]\);/)?.[0];
    expect(fn).toBeDefined();
    const show = fn!.indexOf('setSessionSelector({ visible: true })');
    const read = fn!.indexOf('await client.getSessions');
    expect(show).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    // The whole defect: visibility used to come after the await.
    expect(show).toBeLessThan(read);
  });

  test('openSessionSelector never re-shows the sheet after the await', () => {
    // A read landing after the operator dismissed used to re-open the sheet.
    const fn = provider.match(/const openSessionSelector = useCallback\([\s\S]*?\n  \}, \[\]\);/)?.[0];
    const afterAwait = fn!.slice(fn!.indexOf('await client.getSessions'));
    expect(afterAwait).not.toContain('setSessionSelector');
  });

  test('a superseded read is dropped instead of overwriting a fresher one', () => {
    const fn = provider.match(/const openSessionSelector = useCallback\([\s\S]*?\n  \}, \[\]\);/)?.[0];
    expect(fn).toContain('if (seq !== sessionReadSeqRef.current) return;');
  });

  test('openModelPicker has the same shape', () => {
    const fn = provider.match(/const openModelPicker = useCallback\([\s\S]*?\n  \}, \[\]\);/)?.[0];
    expect(fn).toBeDefined();
    const show = fn!.indexOf('setModelPicker({ visible: true');
    const read = fn!.indexOf('await client.getModels');
    expect(show).toBeLessThan(read);
    expect(fn!.slice(read)).not.toContain('setModelPicker');
  });
});

describe('the sheet distinguishes reading from empty', () => {
  const sheet = readSource('src', 'components', 'chat', 'thread-config-sheet.tsx');

  test('an unloaded, unfailed, empty list reads as "Reading sessions", not "No sessions yet"', () => {
    expect(sheet).toContain('{sessions.length === 0 && !sessionsLoaded && !sessionsError ? (');
    expect(sheet).toContain('title="Reading sessions…"');
  });

  test('a genuinely empty loaded list still says "No sessions yet"', () => {
    expect(sheet).toContain("title={sessionsError ?? 'No sessions yet'}");
  });
});
