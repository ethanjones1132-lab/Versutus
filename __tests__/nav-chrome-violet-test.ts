declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const readNavTheme = () => readSource(['src', 'constants', 'navigation-theme.ts']);
const readHome = () => readSource(['src', 'app', '(tabs)', 'home.tsx']);
const readTabsLayout = () => readSource(['src', 'app', '(tabs)', '_layout.tsx']);
const readTokens = () => readSource(['src', 'constants', 'tokens.ts']);

/**
 * Contract test for the ambient + navigation chrome pass (CHARTER priority
 * 1, visual-direction 2026-09): the route theme's primary/notification and
 * Home's pull-to-refresh wear brand `accent`, the NativeTabs selected pair
 * pinned by tab-ia-chat-root-test stays on `accentWarm`, and the brand
 * accent is violet — never metallic gold.
 */
describe('System chrome reads one brand violet at rest', () => {
  test('route theme primary and notification wear brand accent', () => {
    const src = readNavTheme();
    expect(src).toContain('primary: Palette.accent,');
    expect(src).toContain('notification: Palette.accent,');
    expect(src).not.toContain('accentWarm');
    expect(src).not.toContain('Palette.gold');
    expect(src).not.toContain('#D4AF37');
    // Stage keys the theme already resolved stay put.
    expect(src).toContain('background: Palette.background,');
    expect(src).toContain('card: Palette.backgroundElevated,');
    expect(src).toContain('text: Palette.textPrimary,');
    expect(src).toContain('border: Palette.border,');
  });

  test('Home pull-to-refresh tints brand accent, not the focus tint', () => {
    const src = readHome();
    expect(src).toContain('tintColor={tokens.accent}');
    expect(src).toContain('colors={[tokens.accent]}');
    expect(src).toContain('progressBackgroundColor={tokens.backgroundElevated}');
    expect(src).not.toContain('tokens.accentWarm');
  });

  test('NativeTabs selected chrome stays on the pinned accentWarm pair', () => {
    const src = readTabsLayout();
    expect(src).toContain('selected: Palette.accentWarm');
    expect(src).toContain('tintColor={Palette.accentWarm}');
    expect(src).toContain('indicatorColor={Palette.accentMuted}');
    expect(src).not.toContain('Palette.gold');
  });

  test('brand accent is soft electric violet; gold stays a separate highlight', () => {
    const tokens = readTokens();
    expect(tokens).toContain("accent: '#8B7CFF'");
    expect(tokens).toContain("gold: '#D4AF37'");
    const theme = readNavTheme();
    const home = readHome();
    expect(theme).not.toContain("'#D4AF37'");
    expect(home).not.toContain("'#D4AF37'");
    expect(home).not.toContain('Palette.gold');
  });
});
