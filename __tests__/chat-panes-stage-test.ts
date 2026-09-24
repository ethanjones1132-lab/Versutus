jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

import { Palette } from '@/constants/tokens';

declare const __dirname: string;

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const PANE_FILES: [string[], string][] = [
  [['src', 'components', 'chat', 'bot-memory-pane.tsx'], 'memory'],
  [['src', 'components', 'chat', 'routines-pane.tsx'], 'routines'],
  [['src', 'components', 'chat', 'bot-detail-sheet.tsx'], 'bot detail'],
  [['src', 'components', 'chat', 'session-analytics.tsx'], 'session analytics'],
];

function hex(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new Error(`expected 6-digit hex, got ${value}`);
  const number = parseInt(match[1], 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

describe('Chat auxiliary panes rest on the quiet stage', () => {
  it.each(PANE_FILES)('%s leaves the focus tint, glass tiers, and gold behind', (_parts, label) => {
    const src = readSource(..._parts);
    expect(label).toBeTruthy();
    expect(src).not.toMatch(/accentWarm|accentWarmMuted|glassBorder|Palette\.glass|Palette\.gold/);
    expect(src).not.toMatch(/rgba\(\s*240\s*,\s*214\s*,\s*144/);
  });

  it('memory keeps its read, edit, confirmation, and failure surfaces', () => {
    const src = readSource('src', 'components', 'chat', 'bot-memory-pane.tsx');
    expect(src.match(/color="accent"/g) ?? []).toHaveLength(3);
    expect(src).toContain("gatewayRequest('bots.memory'");
    expect(src).toContain("gatewayRequest('bots.memory.write'");
    expect(src).toContain('memorySaveConfirmationCopy');
    expect(src).toContain('Confirm save');
    expect(src).toContain('settled.failed');
  });

  it('routines keeps its list, form, retry, and job-sheet surfaces', () => {
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    expect(src).toContain('color="accent"');
    expect(src).toContain('ErrorCard');
    expect(src).toContain('onRetry={onRetry}');
    expect(src).toContain('onCreate(submitted)');
    expect(src).toContain('submitPause(job.id, !job.paused)');
    expect(src).toContain('<CronJobSheet');
    expect(src).toContain('<CronRunSheet');
  });

  it('bot detail keeps its sheet, memory, routing, and handoff surfaces', () => {
    const src = readSource('src', 'components', 'chat', 'bot-detail-sheet.tsx');
    expect(src).toContain("<Text variant=\"caption\" color={soulState.failed ? 'accent' : 'tertiary'}>");
    expect(src).toContain("<Text variant=\"body\" color={detail.routingNext ? 'accent' : undefined}>");
    expect(src).toContain('<Text variant="caption" color="accent">');
    expect(src).toContain('<BaseSheet');
    expect(src).toContain('<BotMemoryPane botId={bot.id} />');
    expect(src).toContain('onMessage');
    expect(src).toContain('onEdit');
    expect(src).toContain('onExport');
    expect(src).toContain('onDismissExportNotice');
  });

  it('session analytics keeps its usage, window, meter, and sparkline surfaces', () => {
    const src = readSource('src', 'components', 'chat', 'session-analytics.tsx');
    expect(src.match(/fill=\{tokens\.accent\}/g) ?? []).toHaveLength(2);
    expect(src).toContain('stroke={tokens.accent}');
    expect(src).toContain('stroke={tokens.border}');
    expect(src).toContain('sessionUsage(session)');
    expect(src).toContain('weekBuckets(sessions, now)');
    expect(src).toContain('relativeMeter');
    expect(src).toContain('spendWindowCopy(rowCount)');
  });

  it('uses the violet brand accent, not metallic gold', () => {
    const [red, green, blue] = hex(Palette.accent);
    expect(blue).toBeGreaterThan(green);
    expect(red).toBeGreaterThan(green);
    expect(Palette.accent).not.toBe(Palette.gold);
  });
});
