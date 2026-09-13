import {
  BOT_HANDOFF_EXCLUDED,
  BOT_HANDOFF_FORMAT,
  BOT_HANDOFF_VERSION,
  botHandoffFromUnknown,
  botHandoffSummaryCopy,
  buildBotHandoff,
  handoffFileName,
} from '@/lib/gateway/handoff';

const NOW = () => '2026-09-13T00:00:00.000Z';

const SOURCE = {
  bot: {
    id: 'scout',
    name: 'Scout',
    description: 'research',
    soul: 'Be terse.',
    modelId: 'kimi-k3',
    // Smuggled fields the packet must never carry.
    memory: 'the operator lives in Berlin',
    credentials: { apiKey: 'sk-secret' },
  },
  routines: [{ id: 'r1' }, { id: 'r2' }],
  skills: [{ id: 's1' }],
  chrome: { accent: 'blue' },
};

describe('a Bot handoff packet', () => {
  test('carries the allow-listed Bot, routines, skills and chrome, and names the exclusions', () => {
    const packet = buildBotHandoff({ ...SOURCE, now: NOW });
    expect(packet.format).toBe(BOT_HANDOFF_FORMAT);
    expect(packet.version).toBe(BOT_HANDOFF_VERSION);
    expect(packet.createdAt).toBe('2026-09-13T00:00:00.000Z');
    expect(packet.bot).toEqual({
      id: 'scout',
      name: 'Scout',
      description: 'research',
      soul: 'Be terse.',
      modelId: 'kimi-k3',
    });
    expect(packet.routines).toHaveLength(2);
    expect(packet.skills).toHaveLength(1);
    expect(packet.chrome).toEqual({ accent: 'blue' });
    expect(packet.excluded).toEqual([...BOT_HANDOFF_EXCLUDED]);
  });

  test('a source carrying memory or credentials cannot leak them into the packet', () => {
    const serialized = JSON.stringify(buildBotHandoff({ ...SOURCE, now: NOW }));
    expect(serialized).not.toContain('the operator lives in Berlin');
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('apiKey');
  });

  test('a foreign or malformed packet is rejected, and a real one round-trips', () => {
    expect(botHandoffFromUnknown(null)).toBeNull();
    expect(botHandoffFromUnknown({ format: 'other', version: 1, bot: { id: 'x' } })).toBeNull();
    expect(
      botHandoffFromUnknown({ format: BOT_HANDOFF_FORMAT, version: 99, bot: { id: 'x' } }),
    ).toBeNull();
    expect(botHandoffFromUnknown({ format: BOT_HANDOFF_FORMAT, version: 1, bot: {} })).toBeNull();

    const built = buildBotHandoff({ ...SOURCE, now: NOW });
    expect(botHandoffFromUnknown(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  test('the file name is a safe slug of the Bot', () => {
    expect(handoffFileName(buildBotHandoff({ ...SOURCE, now: NOW }))).toBe('versutus-bot-scout.json');
    expect(
      handoffFileName(
        buildBotHandoff({ bot: { id: 'x', name: 'Doctor Strange!!' }, now: NOW }),
      ),
    ).toBe('versutus-bot-doctor-strange.json');
  });

  test('the summary names the Bot and the exclusion', () => {
    const copy = botHandoffSummaryCopy(buildBotHandoff({ ...SOURCE, now: NOW }));
    expect(copy).toContain('Scout');
    expect(copy).toMatch(/2 routines/);
    expect(copy).toMatch(/1 skill/);
    expect(copy).toMatch(/memory and credentials/i);
  });
});

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

describe('the export is wired behind a share sheet', () => {
  test('the Bot detail sheet offers Export only when the parent can share', () => {
    const sheet = readSource('src', 'components', 'chat', 'bot-detail-sheet.tsx');
    expect(sheet).toContain('onExport');
    expect(sheet).toContain('Export handoff');

    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(screen).toContain('shareBotHandoff(');
    expect(screen).toContain(
      'onExport={detailBot && handoffShareReady ? handleExportBot : undefined}',
    );
  });
});
