// tokens.ts only needs Easing for Motion curves; reanimated's native
// worklet unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

declare const __dirname: string;

import { Palette } from '@/constants/tokens';

/**
 * Contract test for the selection-primitives brand pass
 * (visual-direction-2026-09): chips, badges, list-row halos and segmented
 * controls rest on flat near-black fills with cool hairlines and wear soft
 * electric violet (brand `accent`) instead of a glass highlight fill or the
 * brighter focus tint. Public props APIs are unchanged.
 */

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(file: string): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'ui', file].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function hex(value: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(value);
  if (!m) throw new Error(`expected 6-digit hex, got ${value}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const files = ['Chip.tsx', 'Badge.tsx', 'ListRow.tsx', 'SegmentedControl.tsx'] as const;

describe('selection primitives share the locked brand + stage language', () => {
  it('no primitive paints a glass fill or gold', () => {
    for (const file of files) {
      const src = readSource(file);
      expect(src).not.toMatch(/glassHighlight|glassBorder|Palette\.glass\b|Palette\.gold/);
    }
  });

  it('brand accent is soft electric violet, never gold', () => {
    const [r, g, b] = hex(Palette.accent);
    expect(b).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(g);
    expect(Palette.accent).not.toBe(Palette.gold);
  });
});

describe('Chip rests on the flat elevated panel with brand-violet selection', () => {
  const src = readSource('Chip.tsx');

  it('unselected fill is the flat elevated stage panel, not glass', () => {
    expect(src).toContain('tokens.backgroundElevated');
    expect(src).not.toContain('tokens.glassHighlight');
  });

  it('selected border, glyph and label wear the brand accent', () => {
    expect(src).toContain("borderColor: selected ? tokens.accent : tokens.border");
    expect(src).toContain("color={selected ? 'accent' : 'textSecondary'}");
    expect(src).toContain("color={selected ? 'accent' : 'secondary'}");
    expect(src).not.toMatch(/accentWarm/);
  });

  it('keeps the ChipProps API', () => {
    expect(src).toContain('export type ChipProps');
    for (const prop of ['label', 'onPress', 'selected', 'icon', 'disabled']) {
      expect(src).toContain(prop);
    }
  });
});

describe('Badge tones sit on muted brand/status fills with brand accent text', () => {
  const src = readSource('Badge.tsx');

  it('neutral fill is the flat elevated panel, not glass', () => {
    expect(src).toContain('backgroundColor: Palette.backgroundElevated');
    expect(src).not.toContain('Palette.glassHighlight');
  });

  it('accent tone is brand violet throughout, never the focus tint', () => {
    const accentBlock = src.slice(src.indexOf('accent: {'), src.indexOf('success: {'));
    expect(accentBlock).toContain('Palette.accentMuted');
    expect(accentBlock).toContain('color: Palette.accent');
    expect(accentBlock).not.toContain('accentWarm');
    expect(src).not.toMatch(/accentWarm/);
  });

  it('keeps the BadgeTone API and semantic status tones', () => {
    expect(src).toContain("export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'");
    expect(src).toContain('Palette.statusConnectedMuted');
    expect(src).toContain('Palette.statusDisconnectedMuted');
  });
});

describe('ListRow halo is a flat inset panel with a brand-violet glyph', () => {
  const src = readSource('ListRow.tsx');

  it('icon halo uses the inset variant and accent glyph, not chip/accentWarm', () => {
    expect(src).toContain('variant="inset"');
    expect(src).toContain('color="accent"');
    expect(src).not.toContain('variant="chip"');
    expect(src).not.toMatch(/accentWarm/);
  });

  it('keeps the ListRowProps API', () => {
    expect(src).toContain('export type ListRowProps');
    for (const prop of ['title', 'subtitle', 'icon', 'statusColor', 'leading', 'trailing', 'selected']) {
      expect(src).toContain(prop);
    }
  });
});

describe('SegmentedControl selection reads brand violet on a cool hairline', () => {
  const src = readSource('SegmentedControl.tsx');

  it('indicator keeps the muted brand fill behind a cool hairline border', () => {
    expect(src).toContain('backgroundColor: tokens.accentMuted, borderColor: tokens.border');
    expect(src).not.toContain('accentWarmMuted');
  });

  it('selected segment label is the brand accent', () => {
    expect(src).toContain("color={selected ? 'accent' : 'secondary'}");
    expect(src).not.toMatch(/accentWarm/);
  });

  it('keeps the SegmentedControlProps API', () => {
    expect(src).toContain('export type SegmentedControlProps');
    for (const prop of ['options', 'selectedKey', 'onSelect']) {
      expect(src).toContain(prop);
    }
  });
});
