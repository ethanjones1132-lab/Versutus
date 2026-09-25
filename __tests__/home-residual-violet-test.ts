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

const statusCard = () => readSource('src', 'components', 'home-status-card.tsx');
const briefing = () => readSource('src', 'components', 'home-briefing-card.tsx');
const dashboard = () =>
  readSource('src', 'components', 'gateway', 'gateway-home-dashboard.tsx');

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

// CHARTER priority 1 / docs/visual-direction-2026-09.md: the Home residual
// still printed the brighter focus violet and a glass hero ring at rest, so
// the demoted status screen read warmer than the Chat stage it serves.
describe('Home residual chrome reads brand violet on the cool stage', () => {
  it('the status hero draws its metal rule, eyebrow and spinner from the brand', () => {
    const src = statusCard();
    expect(src).toContain('<View style={[styles.metalRule, { backgroundColor: tokens.accent }]} />');
    expect(src).toContain('color="accent" style={styles.eyebrow}');
    expect(src).toContain('<ActivityIndicator color={tokens.accent} />');
    expect(src).not.toContain('accentWarm');
    expect(src).not.toContain('glassHeroBorder');
  });

  it('the "while you were away" digest wears the brand eyebrow and clock', () => {
    const src = briefing();
    expect(occurrences(src, 'color="accent"')).toBe(2);
    expect(src).toContain('color="accent"\n        />');
    expect(src).not.toContain('accentWarm');
  });

  it('the dashboard approval card and run hint read brand violet', () => {
    const src = dashboard();
    expect(src).toContain('style={[styles.approvalCard, { borderColor: tokens.accent }]}');
    expect(occurrences(src, 'color="accent" style={styles.approvalLabel}')).toBe(2);
    expect(src).toContain('color="accent"\n            />');
    expect(src).toMatch(/eyebrow: \{\n    color: Palette\.accent,/);
    expect(src).not.toContain('accentWarm');
  });

  it('the hero orb sits on a cool hairline, not glass chrome', () => {
    const src = dashboard();
    expect(src).toContain('<View style={[styles.orb, { borderColor: tokens.borderStrong }]}>');
    expect(src).not.toContain('glassHeroBorder');
  });

  it('brand violet is violet — gold and the focus tint stay out of the residual', () => {
    expect(Palette.accent).not.toBe(Palette.gold);
    expect(Palette.accent).not.toBe(Palette.accentWarm);
    expect(Palette.accent).toBe('#8B7CFF');
  });
});

describe('the residual keeps its behaviour and semantic status colours', () => {
  it('the status card keeps its connect / open-chat CTAs and phase copy', () => {
    const src = statusCard();
    for (const needle of [
      'label="Open chat"',
      "phase === 'failed' ? 'Try again' : 'Connect now'",
      'onPress={onConnect}',
      'onOpenChat',
      '<ConnectionBadge status={status} />',
      '<ConnectionTimeline',
      'Approve this phone on your PC — details are on the Chat tab.',
    ]) {
      expect(src).toContain(needle);
    }
    expect(src).not.toContain('color="statusDisconnected"');
  });

  it('the digest still renders nothing without a stamp or without news', () => {
    const src = briefing();
    expect(src).toContain('if (!summary || summary.isEmpty) return null');
    expect(src).toContain('While you were away');
    expect(src).toContain("router.push('/activity')");
  });

  it('the dashboard keeps approval review, retry and status-strip entries', () => {
    const src = dashboard();
    for (const needle of [
      'label="Review approval"',
      'label="Retry connection"',
      "onOpenChat={() => router.push('/chat')}",
      'statusStrip',
      '<ChannelStatusRow',
      '<HomeBriefingCard />',
    ]) {
      expect(src).toContain(needle);
    }
    // Connection verdicts stay semantic: the orb dot and badge resolve status.
    expect(src).toContain('const orbColor = statusColor(tokens, status);');
    expect(src).toContain("tone={connected ? 'success' : status === 'pairing' ? 'accent' : 'neutral'}");
  });
});
