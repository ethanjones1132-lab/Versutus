import {
  COMMAND_HISTORY_VISIBLE_LIMIT,
  commandHistoryEmptyCopy,
  commandHistoryWindowCopy,
} from '@/lib/gateway/command-history';
import { commandTranscriptMarkdown } from '@/lib/gateway/transcript-export';
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

/** The `## <title>` section headings the composer wrote, in file order. */
function entryHeadings(markdown: string): string[] {
  return markdown.split('\n').filter((line) => line.startsWith('## '));
}

const RAW = '{"tool":"shell","args":["hermes -p alpha inspect"]}';

test('the document opens on the transcript, newest command first', () => {
  const older = entry({ id: 'cmd-1', title: 'status', createdAt: 100 });
  const newer = entry({ id: 'cmd-2', title: 'cron list', createdAt: 200 });
  const md = commandTranscriptMarkdown([older, newer]);
  expect(md.startsWith('# Command history')).toBe(true);
  expect(md.indexOf('## cron list')).toBeGreaterThan(-1);
  expect(md.indexOf('## status')).toBeGreaterThan(md.indexOf('## cron list'));
  // The held order is untouched — the composer sorts its own copy.
  expect([older, newer].map((e) => e.id)).toEqual(['cmd-1', 'cmd-2']);
});

test('one section per entry, each naming its own command, status and summary', () => {
  const md = commandTranscriptMarkdown([
    entry({ id: 'cmd-1', title: 'status', status: 'complete', summary: 'gateway ok', createdAt: 100 }),
    entry({ id: 'cmd-2', title: 'cron list', status: 'error', summary: 'no scheduler', createdAt: 200 }),
    entry({ id: 'cmd-3', title: 'session new', status: 'cancelled', summary: 'stopped by operator', createdAt: 300 }),
  ]);
  expect(entryHeadings(md)).toEqual(['## session new', '## cron list', '## status']);
  // The status is written verbatim — the transcript's own word, not a label.
  expect(md).toContain('- Status: cancelled');
  expect(md).toContain('- Status: error');
  expect(md).toContain('- Status: complete');
  expect(md).toContain('- Summary: stopped by operator');
  expect(md).toContain('- Summary: no scheduler');
  expect(md).toContain('- Summary: gateway ok');
});

test('a section names the command through the shipped title rule', () => {
  const md = commandTranscriptMarkdown([entry({ title: '', input: '/cron history x' })]);
  expect(md).toContain('## /cron history x');
});

test('the raw output is withheld unless the operator asks for it', () => {
  const withRaw = entry({ raw: RAW });
  expect(commandTranscriptMarkdown([withRaw])).not.toContain(RAW);
  expect(commandTranscriptMarkdown([withRaw])).not.toContain('### Raw output');
  expect(commandTranscriptMarkdown([withRaw], {})).not.toContain(RAW);
  expect(commandTranscriptMarkdown([withRaw], { includeRaw: false })).not.toContain(RAW);
  // Only the payload is withheld — the section beside it is still written.
  expect(commandTranscriptMarkdown([withRaw])).toContain('- Summary: ok');
});

test('the raw output is appended under the flag', () => {
  const md = commandTranscriptMarkdown([entry({ raw: RAW })], { includeRaw: true });
  expect(md).toContain('### Raw output');
  expect(md).toContain(`\`\`\`\n${RAW}\n\`\`\``);
  expect(md.indexOf('### Raw output')).toBeGreaterThan(md.indexOf('- Summary: ok'));
});

test('a stored raw that is not a string is never printed', () => {
  const plain = commandTranscriptMarkdown([entry()]);
  for (const junk of [42, 0, null, undefined, true, { payload: 'x' }, ['x']]) {
    const md = commandTranscriptMarkdown(
      [entry({ raw: junk as unknown as string })],
      { includeRaw: true },
    );
    expect(md).not.toContain('### Raw output');
    // No payload, no block: the export is the one it writes for no raw at all.
    expect(md).toBe(plain);
  }
});

test('a raw that is blank prints no block', () => {
  const plain = commandTranscriptMarkdown([entry()]);
  expect(commandTranscriptMarkdown([entry({ raw: '' })], { includeRaw: true })).toBe(plain);
  expect(commandTranscriptMarkdown([entry({ raw: '  \n\t' })], { includeRaw: true })).toBe(plain);
});

test('a raw holding its own fence is still one intact block', () => {
  const raw = 'before\n```\ninside\n```\nafter';
  const md = commandTranscriptMarkdown([entry({ raw })], { includeRaw: true });
  expect(md).toContain('````\nbefore');
  expect(md).toContain('after\n````');
});

test('an over-cap held set names its bound instead of reading as the whole transcript', () => {
  const held = Array.from({ length: COMMAND_HISTORY_VISIBLE_LIMIT + 10 }, (_, i) =>
    entry({ id: `cmd-${i}`, title: `command ${i}`, createdAt: i }),
  );
  const md = commandTranscriptMarkdown(held);
  expect(md).toContain(`_${commandHistoryWindowCopy(held.length)}_`);
  expect(md).toContain(`_Showing newest ${COMMAND_HISTORY_VISIBLE_LIMIT}_`);
  // The file holds the same newest slice the section shows, and says so.
  const headings = entryHeadings(md);
  expect(headings).toHaveLength(COMMAND_HISTORY_VISIBLE_LIMIT);
  expect(headings[0]).toBe(`## command ${held.length - 1}`);
  expect(md).not.toContain('## command 0\n');
});

test('an at-or-under-cap held set carries no bound line', () => {
  const held = Array.from({ length: COMMAND_HISTORY_VISIBLE_LIMIT }, (_, i) =>
    entry({ id: `cmd-${i}`, title: `command ${i}`, createdAt: i }),
  );
  const md = commandTranscriptMarkdown(held);
  expect(commandHistoryWindowCopy(held.length)).toBeUndefined();
  expect(md).not.toContain('Showing newest');
  expect(entryHeadings(md)).toHaveLength(COMMAND_HISTORY_VISIBLE_LIMIT);
});

test('an empty held set reads as the honest empty note', () => {
  expect(commandTranscriptMarkdown([])).toBe(
    `# Command history\n\n${commandHistoryEmptyCopy()}\n`,
  );
});

test('the composer reaches no gateway, reads no store and invents no second rule', () => {
  const src = readSource('src', 'lib', 'gateway', 'transcript-export.ts');
  // Exactly two imports: the shipped transcript folds and the entry type.
  expect(src.match(/^import /gm) ?? []).toHaveLength(2);
  expect(src).toContain("from '@/lib/gateway/command-history'");
  expect(src).toContain("from '@/lib/gateway/types'");
  expect(src).not.toContain('keyValueStorage');
  expect(src).not.toContain('gatewayRequest');
  // Ordering, the visible cap and its copy are the shipped folds' own.
  expect(src).toContain('commandHistoryVisible(');
  expect(src).toContain('commandHistoryWindowCopy(');
  expect(src).toContain('commandHistoryRowTitle(');
  expect(src).not.toContain('COMMAND_HISTORY_VISIBLE_LIMIT');
});
