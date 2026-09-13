import {
  BOT_HANDOFF_FORMAT,
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
    expect(parseBotHandoffText(JSON.stringify(packet))).toEqual(packet);
    expect(parseBotHandoffText(packet)).toEqual(packet);
  });

  test('junk, blankness, a wrong format/version and a missing id are not packets', () => {
    expect(parseBotHandoffText('not json')).toBeNull();
    expect(parseBotHandoffText('   ')).toBeNull();
    expect(parseBotHandoffText(null)).toBeNull();
    expect(parseBotHandoffText(undefined)).toBeNull();
    expect(parseBotHandoffText(JSON.stringify({ format: 'other' }))).toBeNull();
    expect(parseBotHandoffText({ format: BOT_HANDOFF_FORMAT, version: 99, bot: { id: 'x' } })).toBeNull();
    expect(parseBotHandoffText({ format: BOT_HANDOFF_FORMAT, version: 1, bot: {} })).toBeNull();
  });
});

describe('botHandoffImportPlan refuses what the receiving host cannot take', () => {
  test('a non-packet and a gateway that cannot create Bots each name their reason', () => {
    const noPacket = botHandoffImportPlan(null, { canCreateBots: true });
    expect(noPacket.ok).toBe(false);
    if (!noPacket.ok) expect(noPacket.reason).toContain('handoff packet');

    const noCapability = botHandoffImportPlan(packet, { canCreateBots: false });
    expect(noCapability.ok).toBe(false);
    if (!noCapability.ok) expect(noCapability.reason).toContain('cannot create Bots');
  });

  test('an allowed packet yields the Bot core and the packet exclusion list', () => {
    const plan = botHandoffImportPlan(packet, { canCreateBots: true });
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
    const copy = botHandoffImportCopy(botHandoffImportPlan(packet, { canCreateBots: true }));
    expect(copy).toContain('Scout');
    expect(copy).toMatch(/never|not applied/i);
    expect(copy).not.toMatch(/imports? (your )?memory/i);
  });

  test('a refused plan shows the reason, not a Bot name', () => {
    const copy = botHandoffImportCopy(botHandoffImportPlan(null, { canCreateBots: true }));
    expect(copy).toContain('handoff packet');
  });
});

// The screen's contract: it reads a packet from the clipboard or a pasted
// field, plans it against the receiving gateway's capability, and only then
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

  test('the roster footer offers the Import row and the screen routes to it', () => {
    expect(roster()).toContain('onImportAgent');
    expect(roster()).toContain('Import handoff');
    expect(chatScreen()).toContain("'/gateway/import'");
    expect(rootLayout()).toContain('name="gateway/import"');
  });
});
