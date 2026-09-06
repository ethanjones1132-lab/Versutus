import {
  COMMAND_HISTORY_VISIBLE_LIMIT,
  commandHistoryEmptyCopy,
  commandHistoryNewestFirst,
  commandHistoryVisible,
  commandHistoryWindowCopy,
} from '@/lib/gateway/command-history';
import type { CommandTranscriptEntry } from '@/lib/gateway/types';

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

function entry(over: Partial<CommandTranscriptEntry> = {}): CommandTranscriptEntry {
  return {
    id: `cmd-${over.createdAt ?? 0}`,
    gatewayId: 'gw-1',
    sessionKey: 'session-a',
    input: '/status',
    title: 'status',
    status: 'complete',
    summary: 'ok',
    createdAt: 0,
    ...over,
  } as CommandTranscriptEntry;
}

test('an at-or-under-cap held set is fully shown and needs no note', () => {
  expect(commandHistoryWindowCopy(0)).toBeUndefined();
  expect(commandHistoryWindowCopy(7)).toBeUndefined();
  expect(commandHistoryWindowCopy(COMMAND_HISTORY_VISIBLE_LIMIT)).toBeUndefined();
});

test('an over-cap held set names its bound instead of reading as the transcript', () => {
  expect(commandHistoryWindowCopy(COMMAND_HISTORY_VISIBLE_LIMIT + 1)).toBe(
    `Showing newest ${COMMAND_HISTORY_VISIBLE_LIMIT}`,
  );
  expect(commandHistoryWindowCopy(COMMAND_HISTORY_VISIBLE_LIMIT + 50)).toContain(
    `newest ${COMMAND_HISTORY_VISIBLE_LIMIT}`,
  );
});

test('an unreadable count never claims the bound', () => {
  expect(commandHistoryWindowCopy(Number.NaN)).toBeUndefined();
  expect(commandHistoryWindowCopy(-1)).toBeUndefined();
});

test('the section renders the window copy under the list when the cap binds', () => {
  const src = readSource('src', 'components', 'chat', 'command-history-section.tsx');
  expect(src).toContain('commandHistoryWindowCopy');
  expect(src).toContain('commandHistoryWindowCopy(commandTranscripts.length)');
  // Micro copy under the rows, inside the open-and-non-empty branch.
  expect(src).toMatch(/variant="micro"[^>]*>[\s\S]*?\{windowCopy\}/);
  const rowsIdx = src.indexOf('<ListRow');
  const copyIdx = src.indexOf('{windowCopy}');
  expect(rowsIdx).toBeGreaterThan(-1);
  expect(copyIdx).toBeGreaterThan(-1);
  expect(copyIdx).toBeGreaterThan(rowsIdx);
});

test('the empty note is byte-identical and ordering is untouched', () => {
  expect(commandHistoryEmptyCopy()).toBe(
    'No slash commands run in this session yet.',
  );
  const older = entry({ id: 'cmd-1', createdAt: 100 });
  const newer = entry({ id: 'cmd-2', createdAt: 200 });
  expect(commandHistoryNewestFirst([older, newer]).map((e) => e.id)).toEqual([
    'cmd-2',
    'cmd-1',
  ]);
  const entries = Array.from({ length: 30 }, (_, i) =>
    entry({ id: `cmd-${i}`, createdAt: i }),
  );
  const visible = commandHistoryVisible(entries);
  expect(visible).toHaveLength(COMMAND_HISTORY_VISIBLE_LIMIT);
  expect(visible[0].id).toBe('cmd-29');
});

test('the window copy never shows for an empty store', () => {
  const src = readSource('src', 'components', 'chat', 'command-history-section.tsx');
  // The copy renders only in the non-empty branch — the empty branch keeps
  // the honest empty note alone.
  const emptyIdx = src.indexOf('commandHistoryEmptyCopy()');
  const copyIdx = src.indexOf('{windowCopy}');
  expect(emptyIdx).toBeGreaterThan(-1);
  expect(copyIdx).toBeGreaterThan(-1);
  expect(copyIdx).toBeGreaterThan(emptyIdx);
});
