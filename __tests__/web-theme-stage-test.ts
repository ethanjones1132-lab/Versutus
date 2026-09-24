jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

declare const __dirname: string;

import { Palette } from '@/constants/tokens';

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function cssValue(source: string, name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(source);
  if (!match) throw new Error(`missing CSS variable ${name}`);
  return match[1].trim().toLowerCase();
}

describe('web theme uses the cool violet stage', () => {
  const css = readSource('src', 'global.css');

  it('mirrors the shared stage, type, brand, and hairline palette', () => {
    expect(cssValue(css, '--color-background')).toBe(Palette.background.toLowerCase());
    expect(cssValue(css, '--color-background-elevated')).toBe(
      Palette.backgroundElevated.toLowerCase(),
    );
    expect(cssValue(css, '--color-accent')).toBe(Palette.accent.toLowerCase());
    expect(cssValue(css, '--color-accent-warm')).toBe(Palette.accentWarm.toLowerCase());
    expect(cssValue(css, '--color-text-primary')).toBe(Palette.textPrimary.toLowerCase());
    expect(cssValue(css, '--color-text-secondary')).toBe(Palette.textSecondary.toLowerCase());
    expect(cssValue(css, '--color-glass')).toBe(Palette.glass.toLowerCase());
    expect(cssValue(css, '--color-glass-border')).toBe(Palette.glassBorder.toLowerCase());
  });

  it('contains no retired champagne or gold theme literals', () => {
    expect(css).not.toMatch(
      /#(?:030304|0a0908|d6b76a|f0d690|f7f1e3|b8ae9a|d4af37)|229\s*,\s*198\s*,\s*126/i,
    );
  });

  it('keeps every font variable in the web theme', () => {
    for (const name of ['--font-display', '--font-mono', '--font-rounded', '--font-serif']) {
      expect(css).toContain(`${name}:`);
    }
  });
});

describe('dev preview rests on brand violet', () => {
  const preview = readSource('src', 'app', 'dev', 'preview.tsx');
  const chip = readSource('src', 'components', 'dev', 'preview-scenario-chip.tsx');

  it('uses brand accent for eyebrows and muted violet for resting rules and edges', () => {
    expect(preview.match(/color="accent"/g)).toHaveLength(2);
    expect(preview).toContain('backgroundColor: tokens.accentMuted');
    expect(chip).toContain('borderColor: Palette.accentMuted');
    expect(preview).not.toContain('accentWarm');
    expect(chip).not.toContain('accentWarm');
  });

  it('keeps the preview scenario switch and press feedback', () => {
    expect(preview).toContain('<ScrollView horizontal');
    expect(preview).toContain('active={item.id === scenarioId}');
    expect(preview).toContain('onPress={() => setScenarioId(item.id)}');
    expect(chip).toContain('scale.value = withSpring(0.94, springSnappy)');
    expect(chip).toContain('scale.value = withSpring(1, springSnappy)');
  });
});
