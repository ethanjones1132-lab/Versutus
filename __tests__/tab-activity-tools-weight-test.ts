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

const readTabsLayout = () => readSource(['src', 'app', '(tabs)', '_layout.tsx']);
const readActivity = () => readSource(['src', 'app', '(tabs)', 'activity.tsx']);
const readTerminal = () => readSource(['src', 'components', 'terminal', 'terminal-screen.tsx']);
const readCommandChip = () => readSource(['src', 'components', 'terminal', 'command-chip.tsx']);

/**
 * Contract test for Activity + Tools weight after the side-drawer IA:
 * no bottom tab bar chrome to tint; Activity and Tools screens still inherit
 * the flat cool stage — brand violet at rest, never glass tiers or gold.
 */
describe('Activity and Tools carry quieter weight than Chat', () => {
  test('the layout ships a side drawer with zero NativeTabs and no gold', () => {
    const src = readTabsLayout();
    expect(src).toContain('<Drawer');
    expect(src).not.toContain('NativeTabs');
    expect(src).not.toContain('Palette.gold');
    expect(src).not.toContain('#D4AF37');
  });

  test('Activity refresh wears brand violet at rest, never the focus tint', () => {
    const src = readActivity();
    expect(src).toContain('tintColor={tokens.accent}');
    expect(src).toContain('colors={[tokens.accent]}');
    expect(src).not.toContain('tokens.accentWarm');
    expect(src).not.toMatch(/tokens\.glass\b|tokens\.glassBorder/);
  });

  test('the Tools screen lands on flat cool hairlines and brand-violet chrome', () => {
    const src = readTerminal();
    expect(src).not.toMatch(/tokens\.glass\b|tokens\.glassBorder/);
    expect(src).not.toContain('accentWarm');
    // Resting borders — pane, banner, input card, result card — are hairlines.
    expect(src).toContain('borderColor: tokens.border');
    expect(src).toContain('borderBottomColor: tokens.border');
    expect(src).toContain('borderColor: tokens.border }]}');
    // Header kicker and Copy control wear brand accent, not the focus tint.
    expect(src).toContain('color="accent" style={styles.headerKicker}');
    expect(src).toContain('color="accent"');
    expect(src).not.toContain('Palette.gold');
  });

  test('the Tools command chip drops glass tiers for the elevated stage panel', () => {
    const src = readCommandChip();
    expect(src).not.toMatch(/tokens\.glass\b|tokens\.glassBorder/);
    expect(src).toContain('borderColor: tokens.border');
    expect(src).toContain('backgroundColor: tokens.backgroundElevated');
  });
});
