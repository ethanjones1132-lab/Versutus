import {
  commandHistoryEmptyCopy,
  commandHistoryNewestFirst,
  commandHistoryRowTitle,
  commandHistoryToggleLabel,
  commandHistoryVisible,
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

const section = () =>
  readSource('src', 'components', 'chat', 'command-history-section.tsx');

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

test('held entries render newest-first with their result text', () => {
  const older = entry({ id: 'cmd-1', input: '/status', summary: 'first', createdAt: 100 });
  const newer = entry({ id: 'cmd-2', input: '/cron history', summary: 'second', createdAt: 200 });
  const ordered = commandHistoryNewestFirst([older, newer]);
  expect(ordered.map((e) => e.id)).toEqual(['cmd-2', 'cmd-1']);
  expect(ordered[0].summary).toBe('second');
  // The held order is untouched — the view sorts its own copy.
  expect([older, newer].map((e) => e.id)).toEqual(['cmd-1', 'cmd-2']);
});

test('the visible slice keeps only the most recent entries', () => {
  const entries = Array.from({ length: 30 }, (_, i) =>
    entry({ id: `cmd-${i}`, createdAt: i }),
  );
  const visible = commandHistoryVisible(entries);
  expect(visible).toHaveLength(20);
  expect(visible[0].id).toBe('cmd-29');
  expect(visible[19].id).toBe('cmd-10');
});

test('an empty store renders the honest empty note, never a blank sheet', () => {
  expect(commandHistoryEmptyCopy()).toBe(
    'No slash commands run in this session yet.',
  );
  expect(commandHistoryNewestFirst([])).toEqual([]);
  expect(commandHistoryVisible([])).toEqual([]);
});

test('the toggle is collapsed by default and counts the held entries', () => {
  expect(commandHistoryToggleLabel(false, 0)).toBe('Command history');
  expect(commandHistoryToggleLabel(false, 3)).toBe('Command history (3)');
  expect(commandHistoryToggleLabel(true, 3)).toBe('Hide history');
});

test('a row names the command even when the entry has no title', () => {
  expect(commandHistoryRowTitle(entry({ title: 'status', input: '/status' }))).toBe(
    'status',
  );
  expect(commandHistoryRowTitle(entry({ title: '', input: '/cron history x' }))).toBe(
    '/cron history x',
  );
});

test('the section reads the already-held entries with no new fetch or store', () => {
  const src = section();
  expect(src).toContain('commandTranscripts');
  expect(src).toContain('commandHistoryVisible');
  expect(src).toContain('commandHistoryToggleLabel');
  expect(src).not.toContain('loadTranscripts(');
  expect(src).not.toContain('appendTranscript(');
  expect(src).not.toContain('updateTranscript(');
  expect(src).not.toContain('gatewayRequest(');
  expect(src).not.toContain('useState<CommandTranscriptEntry[]>');
});

test('the section is collapsed by default and display-only', () => {
  const src = section();
  expect(src).toContain('useState(false)');
  expect(src).toContain('Command history');
  expect(src).toContain('commandHistoryEmptyCopy');
  // Rows carry no press handler — the history rows stay read-only, and the
  // section's own controls (the toggle, the copy action) sit outside them.
  expect(src).toContain('<ListRow key={row.id} title={row.title}');
  const rows = src.match(/<ListRow[^>]*>/g) ?? [];
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row).not.toContain('onPress');
});

test('the section has one export path, and it is the Markdown composer', () => {
  const src = section();
  // Exactly one call site, and it hands the composer the entries the section
  // holds — not a slice the section cut for itself.
  expect(src.match(/commandTranscriptMarkdown\(/g) ?? []).toHaveLength(1);
  expect(src).toContain('commandTranscriptMarkdown(commandTranscripts)');
  expect(src).toContain('Clipboard.setStringAsync');
  expect(src).toContain('label="Copy Markdown"');
  // No second way out: no direct serialization, no store re-read, no gateway.
  expect(src).not.toContain('JSON.stringify');
  expect(src).not.toContain('loadTranscripts(');
  expect(src).not.toContain('gatewayRequest(');
  // The control sits under the rows it copies, inside the open-and-non-empty
  // branch — an empty history offers nothing to copy.
  const rowsIdx = src.indexOf('<ListRow');
  const buttonIdx = src.indexOf('label="Copy Markdown"');
  const emptyIdx = src.indexOf('commandHistoryEmptyCopy()');
  expect(buttonIdx).toBeGreaterThan(rowsIdx);
  expect(buttonIdx).toBeGreaterThan(emptyIdx);
  // The default is redaction: the section never asks the composer for raw.
  expect(src).not.toContain('includeRaw');
});

test('the history block lives in the chat overflow sheet', () => {
  const sheet = readSource('src', 'components', 'chat', 'chat-overflow-sheet.tsx');
  expect(sheet).toContain('CommandHistorySection');
});

test('recording, keying, and reload-rehydrate stay untouched', () => {
  const provider = readSource('src', 'context', 'gateway-provider.tsx');
  expect(provider).toContain('appendTranscript(activeGateway.id, sessionKey, entry)');
  expect(provider).toContain('loadTranscripts(gateway.id, sessionKey)');
  expect(provider).toContain('clearTranscriptsForGateway(removedId)');
  expect(provider).toContain('setTranscripts(localTrans)');
});
