// tokens.ts only needs Easing for Motion curves; reanimated's native
// worklet unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

declare const __dirname: string;

import { Palette } from '@/constants/tokens';

/**
 * Contract test for the Chat shell face-lift (CHARTER priority 2, visual-
 * direction-2026-09): roster + Bot Chat chrome + composer strip sit on flat
 * cool near-black panels with cool hairlines, resting chrome wears the brand
 * violet, and the composer field focuses violet — no champagne glass, no
 * gold, no glass-tier defaults anywhere in the shell path. Public props and
 * behaviour (drafts, focus, refresh, jump pill) are untouched.
 */

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function hex(value: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(value);
  if (!m) throw new Error(`expected 6-digit hex, got ${value}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const CHROME_FILES: [string[], string][] = [
  [['src', 'components', 'chat', 'chat-composer.tsx'], 'composer'],
  [['src', 'components', 'chat', 'chat-screen.tsx'], 'chat screen chrome'],
  [['src', 'components', 'chat', 'chat-roster.tsx'], 'roster'],
  [['src', 'components', 'chat', 'chat-header.tsx'], 'chat header'],
  [['src', 'components', 'chat', 'message-bubble.tsx'], 'message bubble'],
  [['src', 'components', 'chat', 'tool-call-card.tsx'], 'tool call card'],
];

describe('Chat shell chrome resolves flat stage + brand violet', () => {
  it.each(CHROME_FILES)('%s drops glass-tier tokens and champagne literals', (parts, label) => {
    const src = readSource(...parts);
    expect(label).toBeTruthy();
    expect(src).not.toMatch(/tokens\.glass\b|tokens\.glassBorder/);
    expect(src).not.toMatch(/rgba\(\s*240\s*,\s*214\s*,\s*144/);
    expect(src).not.toContain('Palette.gold');
    expect(src).not.toContain('Palette.glass');
  });

  it('the composer field focuses violet, not a neutral strong hairline', () => {
    const src = readSource('src', 'components', 'chat', 'chat-composer.tsx');
    expect(src).toContain('borderColor: focused ? tokens.accentWarm : tokens.border');
    expect(src).not.toContain('borderStrong :');
    expect(src).toContain('backgroundColor: isStreaming ? tokens.accentWarm : tokens.accent');
  });

  it('pull-to-refresh across roster + thread wears the brand violet', () => {
    for (const parts of [
      ['src', 'components', 'chat', 'chat-screen.tsx'],
      ['src', 'components', 'chat', 'chat-roster.tsx'],
    ]) {
      const src = readSource(...parts);
      expect(src).toContain('tintColor={tokens.accent}');
      expect(src).toContain('colors={[tokens.accent]}');
      expect(src).not.toContain('tintColor={tokens.accentWarm}');
    }
  });

  it('the jump pill and attach notice sit on cool hairlines with brand accents', () => {
    const src = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(src).toContain('{ backgroundColor: tokens.backgroundRaised, borderColor: tokens.border }');
    expect(src).toContain('size={13} color="accent"');
    expect(src).toContain('color="accent" style={styles.attachNoticeText}');
  });

  it('the brand accent is soft electric violet, never gold', () => {
    const [r, g, b] = hex(Palette.accent);
    expect(b).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(g);
    expect(Palette.accent).not.toBe(Palette.gold);
  });
});

describe('TextField defaults land on the flat stage', () => {
  it('the React Native field paints the inset stage panel with a cool hairline', () => {
    const src = readSource('src', 'components', 'ui', 'TextField.tsx');
    expect(src).toContain('backgroundColor: tokens.backgroundInset');
    expect(src).toContain(': tokens.border;');
    expect(src).not.toMatch(/tokens\.glass\b|tokens\.glassBorder/);
  });

  it('the iOS field matches: inset background, cool host hairline', () => {
    const src = readSource('src', 'components', 'ui', 'TextField.ios.tsx');
    expect(src).toContain('background(Palette.backgroundInset)');
    expect(src).toContain(': tokens.border;');
    expect(src).not.toMatch(/Palette\.glass\b|tokens\.glassBorder/);
  });
});
