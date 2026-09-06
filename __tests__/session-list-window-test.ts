import {
  SESSION_LIST_MAX,
  SESSION_LIST_PAGE_SIZE,
  nextSessionListLimit,
  sessionListMayHaveOlder,
  sessionListWindowCopy,
} from '@/lib/gateway/session-list';

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

test('a partial window is the whole catalogue and needs no note', () => {
  expect(sessionListWindowCopy(0)).toBeUndefined();
  expect(sessionListWindowCopy(7)).toBeUndefined();
  expect(sessionListWindowCopy(SESSION_LIST_MAX - 1)).toBeUndefined();
});

test('a filled window names its bound instead of reading as the catalogue', () => {
  expect(sessionListWindowCopy(SESSION_LIST_MAX)).toBe(
    `Showing newest ${SESSION_LIST_MAX} sessions`,
  );
  expect(sessionListWindowCopy(SESSION_LIST_MAX + 50)).toContain(
    `newest ${SESSION_LIST_MAX} sessions`,
  );
});

test('an unreadable count never claims the bound', () => {
  expect(sessionListWindowCopy(Number.NaN)).toBeUndefined();
  expect(sessionListWindowCopy(-1)).toBeUndefined();
});

test('the selector renders the window copy when the cap binds', () => {
  const src = readSource('src', 'components', 'chat', 'thread-config-sheet.tsx');
  expect(src).toContain('sessionListWindowCopy');
  expect(src).toContain('sessionListWindowCopy(sessions.length)');
  // Micro copy under the list, in the slot the Show-older button vacates.
  expect(src).toMatch(/variant="micro"[^>]*>[\s\S]*?\{windowCopy\}/);
  const olderIdx = src.indexOf('Show older sessions');
  const copyIdx = src.indexOf('{windowCopy}');
  expect(olderIdx).toBeGreaterThan(-1);
  expect(copyIdx).toBeGreaterThan(-1);
  expect(copyIdx).toBeGreaterThan(olderIdx);
});

test('page-widening below the cap is untouched', () => {
  const src = readSource('src', 'components', 'chat', 'thread-config-sheet.tsx');
  expect(src).toContain('Show older sessions');
  expect(src).toContain('onShowOlder && hasMoreSessions');
  expect(nextSessionListLimit(20)).toBe(40);
  expect(nextSessionListLimit(200)).toBe(200);
  expect(SESSION_LIST_PAGE_SIZE).toBe(20);
  expect(SESSION_LIST_MAX).toBe(200);
  expect(sessionListMayHaveOlder(20, 20)).toBe(true);
  expect(sessionListMayHaveOlder(200, 200)).toBe(false);
});

test('the confirm-gated session delete is untouched', () => {
  const src = readSource('src', 'components', 'chat', 'thread-config-sheet.tsx');
  expect(src).toContain('<ConfirmSheet');
  expect(src).toContain('Delete session?');
  expect(src).toContain('confirmLabel="Delete session"');
});
