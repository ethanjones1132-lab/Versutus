// tokens.ts only needs Easing for Motion curves; reanimated's native
// worklet unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

declare const __dirname: string;

import { Palette } from '@/constants/tokens';

/**
 * Contract test for the Chat composer + empty-state luxury pass (CHARTER
 * priority 2, visual-direction-2026-09): empty/not-connected titles lead with
 * bright cool-white hierarchy, their CTAs are violet brand actions, the
 * not-connected rule is brand violet, and resting composer quick actions wear
 * the brand accent — the brighter `accentWarm` focus tint stays reserved for
 * focus/stream states. No champagne/gold/glass-tier defaults in this path.
 * Draft + focus behaviour (composerFocusApplies, draft keys) is untouched.
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

const EMPTY_PATH: [string[], string][] = [
  [['src', 'components', 'ui', 'EmptyState.tsx'], 'shared empty surface'],
  [['src', 'components', 'chat', 'chat-empty-state.tsx'], 'not-connected empty'],
  [['src', 'components', 'chat', 'chat-composer.tsx'], 'composer'],
];

describe('Empty states lead with bright-white hierarchy and violet CTAs', () => {
  it.each(EMPTY_PATH)('%s drops champagne/gold/glass-tier defaults', (parts, label) => {
    const src = readSource(...parts);
    expect(label).toBeTruthy();
    expect(src).not.toMatch(/tokens\.glass\b|tokens\.glassBorder/);
    expect(src).not.toMatch(/rgba\(\s*240\s*,\s*214\s*,\s*144/);
    expect(src).not.toMatch(/rgba\(\s*255\s*,\s*236\s*,\s*190/);
    expect(src).not.toContain('Palette.gold');
    expect(src).not.toContain('Palette.glass');
  });

  it('the shared EmptyState action is a primary violet CTA, not a flat secondary', () => {
    const src = readSource('src', 'components', 'ui', 'EmptyState.tsx');
    expect(src).toContain('variant="primary"');
    expect(src).toContain('variant="headline"');
    expect(src).toContain('color="accent"');
    expect(src).not.toContain('variant="secondary"');
  });

  it('the not-connected empty rule wears the brand violet, not the focus tint', () => {
    const src = readSource('src', 'components', 'chat', 'chat-empty-state.tsx');
    expect(src).toContain('backgroundColor: Palette.accent');
    expect(src).not.toContain('Palette.accentWarm');
    expect(src).toContain('borderColor: Palette.borderStrong');
  });

  it('its CTAs stay the violet primary Connect plus the accent ghost', () => {
    const src = readSource('src', 'components', 'chat', 'chat-empty-state.tsx');
    expect(src).toContain('<Button label="Connect to gateway" onPress={onConnect} />');
    expect(src).toContain('<Button label="Go to Home" variant="ghost" onPress={onGoHome} />');
  });

  it('the composer quick actions rest on the brand accent; focus/stream keep the brighter tint', () => {
    const src = readSource('src', 'components', 'chat', 'chat-composer.tsx');
    // The one-tap commands moved off the dock's chip row and into the `+`
    // menu; the rows still rest on the brand accent glyph.
    expect(src).toContain('<Icon name={action.icon} size={14} color="accent" />');
    expect(src).toContain('accessibilityLabel={`Quick action ${action.label}`}');
    expect(src).toContain('accessibilityLabel="Add image or command"');
    // Focus ring and streaming send are the two live states accentWarm is for.
    expect(src).toContain('borderColor: focused ? tokens.accentWarm : tokens.border');
    expect(src).toContain('backgroundColor: isStreaming ? tokens.accentWarm : tokens.accent');
  });

  it('the brand accent is soft electric violet, never gold', () => {
    const m = /^#([0-9a-f]{6})$/i.exec(Palette.accent);
    expect(m).not.toBeNull();
    const n = parseInt(m![1], 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    expect(b).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(g);
    expect(Palette.accent).not.toBe(Palette.gold);
    expect(Palette.accentWarm).not.toBe(Palette.gold);
  });
});
