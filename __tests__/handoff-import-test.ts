import {
  BOT_HANDOFF_FORMAT,
  BOT_HANDOFF_VERSION,
  buildBotHandoff,
} from '@/lib/gateway/handoff';
import {
  botHandoffImportCopy,
  botHandoffImportPlan,
  parseBotHandoffText,
} from '@/lib/gateway/handoff-import';

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

const NOW = () => '2026-09-13T00:00:00.000Z';
const packet = buildBotHandoff({
  bot: { id: 'scout', name: 'Scout', description: 'keeps the watch', soul: 'Watchful.' },
  now: NOW,
});

describe('parseBotHandoffText reads what the export wrote', () => {
  test('it accepts the packet as JSON text or already parsed', () => {
    expect(parseBotHandoffText(JSON.stringify(packet))).toEqual({ ok: true, packet });
    expect(parseBotHandoffText(packet)).toEqual({ ok: true, packet });
  });

  test('blankness and junk are refused as not JSON', () => {
    expect(parseBotHandoffText('not json')).toEqual({
      ok: false,
      reason: expect.stringContaining('not valid JSON'),
    });
    expect(parseBotHandoffText('   ')).toEqual({
      ok: false,
      reason: expect.stringContaining('not valid JSON'),
    });
  });

  test('a wrong format, a wrong version and a missing id each have their own line', () => {
    const wrongKind = parseBotHandoffText(JSON.stringify({ format: 'other', version: BOT_HANDOFF_VERSION, bot: { id: 'x' } }));
    expect(wrongKind.ok).toBe(false);
    if (!wrongKind.ok) expect(wrongKind.reason).toContain('not a Versutus Bot handoff packet');

    const wrongVersion = parseBotHandoffText(
      JSON.stringify({ format: BOT_HANDOFF_FORMAT, version: BOT_HANDOFF_VERSION + 1, bot: { id: 'x' } }),
    );
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) expect(wrongVersion.reason).toContain('version');

    const noBot = parseBotHandoffText(
      JSON.stringify({ format: BOT_HANDOFF_FORMAT, version: BOT_HANDOFF_VERSION, bot: {} }),
    );
    expect(noBot.ok).toBe(false);
    if (!noBot.ok) expect(noBot.reason).toContain('no Bot record');

    expect(parseBotHandoffText(null)).toEqual({ ok: false, reason: expect.any(String) });
    expect(parseBotHandoffText(undefined)).toEqual({ ok: false, reason: expect.any(String) });
  });
});

describe('botHandoffImportPlan refuses what the receiving host cannot take', () => {
  test('a failed parse keeps its own reason in the plan', () => {
    const plan = botHandoffImportPlan(parseBotHandoffText('not json'), { canCreateBots: true });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain('not valid JSON');
  });

  test('a gateway that cannot create Bots refuses with its own reason', () => {
    const plan = botHandoffImportPlan(parseBotHandoffText(packet), { canCreateBots: false });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain('cannot create Bots');
  });

  test('an allowed packet yields the Bot core and the packet exclusion list', () => {
    const plan = botHandoffImportPlan(parseBotHandoffText(packet), { canCreateBots: true });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.bot.id).toBe('scout');
      expect(plan.bot.soul).toBe('Watchful.');
      expect(plan.excluded).toEqual(['memory', 'credentials']);
      expect(plan.note).toContain('routines');
      expect(plan.note).toContain('never');
    }
  });
});

describe('the import copy never promises what the packet excludes', () => {
  test('an allowed plan names the Bot and what this host applies', () => {
    const copy = botHandoffImportCopy(botHandoffImportPlan(parseBotHandoffText(packet), { canCreateBots: true }));
    expect(copy).toContain('Scout');
    expect(copy).toMatch(/never|not applied/i);
    expect(copy).not.toMatch(/imports? (your )?memory/i);
  });

  test('a refused plan shows the reason, not a Bot name', () => {
    const copy = botHandoffImportCopy(botHandoffImportPlan(parseBotHandoffText('not json'), { canCreateBots: true }));
    expect(copy).toContain('not valid JSON');
  });
});

// The screen's contract: it reads a packet from the clipboard or a picked
// file, plans it against the receiving gateway's capability, and only then
// creates the Bot — never importing memory or credentials, which are not on
// the plan at all.
describe('the import screen and its entry', () => {
  const importScreen = () => readSource('src', 'app', 'gateway', 'import.tsx');
  const roster = () => readSource('src', 'components', 'chat', 'chat-roster.tsx');
  const chatScreen = () => readSource('src', 'components', 'chat', 'chat-screen.tsx');
  const rootLayout = () => readSource('src', 'app', '_layout.tsx');

  test('the screen reads the clipboard and a pasted field, then plans before it creates', () => {
    const src = importScreen();
    expect(src).toContain("from 'expo-clipboard'");
    expect(src).toContain('parseBotHandoffText(');
    expect(src).toContain('botHandoffImportPlan(');
    expect(src).toContain('createBot(');
    expect(src).toContain('botHandoffImportCopy(');
    expect(src).not.toContain('.memory');
    expect(src).not.toContain('.credentials');
  });

  test('a picked file feeds the same plan, and the picker is a real dependency', () => {
    const src = importScreen();
    const pkg = JSON.parse(nodeFs.readFileSync([__dirname, '..', 'package.json'].join(SEP), 'utf8') as string) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toContain('expo-document-picker');
    expect(src).toContain('pickHandoffFile');
    expect(src).toContain('getDocumentAsync');
    expect(src).toMatch(/setText\(picked\.content\)/);
  });

  test('the roster footer offers the Import row and the screen routes to it', () => {
    expect(roster()).toContain('onImportAgent');
    expect(roster()).toContain('Import handoff');
    expect(chatScreen()).toContain("'/gateway/import'");
    expect(rootLayout()).toContain('name="gateway/import"');
  });
});

// Every refusal on this screen — clipboard, file, create — lands in one
// failure record and surfaces through the repo's ErrorCard above the cards,
// never the dimmest caption under them. Retry re-attempts the exact action
// that failed; a later success clears the stale record.
describe('the import screen surfaces a refusal as an ErrorCard', () => {
  const importScreen = () => readSource('src', 'app', 'gateway', 'import.tsx');

  test('the refusal renders the repo ErrorCard above the cards, not a tertiary caption', () => {
    const src = importScreen();
    expect(src).toMatch(/\{failure \? \(\s*<ErrorCard/);
    expect(src).toContain('cause={failure.message}');
    expect(src.indexOf('<ErrorCard')).toBeLessThan(src.indexOf('<Card'));
    expect(src).not.toMatch(/\{error \? \(\s*<Text/);
    expect(src).not.toMatch(/variant="caption" color="tertiary">\s*\{error\}/);
  });

  test('one failure record carries the source of the failed action and the kept message', () => {
    const src = importScreen();
    expect(src).toMatch(
      /type ImportFailure = \{ source: 'clipboard' \| 'file' \| 'import'; message: string \}/,
    );
    expect(src).toContain("setFailure({ source: 'clipboard', message: 'The clipboard could not be read.' })");
    expect(src).toContain('setFailure({ source: \'file\', message: picked.error })');
    expect(src).toContain("setFailure({ source: 'file', message: 'The file could not be read.' })");
    expect(src).toContain(
      'setFailure({ source: \'import\', message: cause instanceof Error ? cause.message : String(cause) })',
    );
  });

  test('the ErrorCard names cause, affected, and next, and Retry re-runs the failed action', () => {
    const src = importScreen();
    expect(src).toContain('affected=');
    expect(src).toContain('next=');
    expect(src).toContain('onRetry={retryFailure}');
    const start = src.indexOf('const retryFailure');
    expect(start).toBeGreaterThan(-1);
    const retry = src.slice(start, src.indexOf('return ('));
    expect(retry).toContain("failure?.source === 'clipboard'");
    expect(retry).toContain('readClipboard()');
    expect(retry).toContain('pickFile()');
    expect(retry).toContain('handleImport()');
  });

  test('a later success clears the stale failure so it never outlives its own fix', () => {
    const src = importScreen();
    expect(src).toContain('clearFailure()');
    expect(src).toMatch(/setText\(value \?\? ''\);\s*clearFailure\(\)/);
    expect(src).toMatch(/setText\(picked\.content\);\s*clearFailure\(\)/);
    expect(src).toMatch(/const handleImport[\s\S]{0,200}clearFailure\(\)/);
  });

  test('the plan card, file note, both source buttons, and the busy Import gate keep working', () => {
    const src = importScreen();
    expect(src).toContain('botHandoffImportPlan(');
    expect(src).toContain('botHandoffImportCopy(');
    expect(src).toContain('label="Read clipboard"');
    expect(src).toContain('label="Pick file"');
    expect(src).toContain('<Button label="Import" onPress={handleImport} disabled={busy} />');
    expect(src).toContain('{fileNote ? (');
    expect(src).toContain('createBot(');
    expect(src).toContain("router.navigate('/chat')");
  });
});
