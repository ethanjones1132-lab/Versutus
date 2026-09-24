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
 * Contract test for the Activity + Tools weight pass (CHARTER priority 3):
 * Chat keeps the full violet selected lift on the tab bar while Activity and
 * Tools opt down to a quiet cool-white selected icon + medium label, and both
 * screens inherit the flat cool stage — brand violet at rest, never glass
 * tiers or champagne leftovers.
 */
describe('Activity and Tools carry quieter weight than Chat', () => {
  test('the bar still offers Chat the violet selected lift, never gold', () => {
    const src = readTabsLayout();
    expect(src).toContain('selected: Palette.accentWarm');
    expect(src).toContain('tintColor={Palette.accentWarm}');
    expect(src).toContain('indicatorColor={Palette.accentMuted}');
    expect(src).not.toContain('Palette.gold');
    expect(src).not.toContain('#D4AF37');
  });

  test('Activity and Tools select to cool white at medium weight, not violet', () => {
    const src = readTabsLayout();
    const activity = src.indexOf('<NativeTabs.Trigger name="activity">');
    const terminal = src.indexOf('<NativeTabs.Trigger name="terminal">');
    const home = src.indexOf('<NativeTabs.Trigger name="home">');
    expect(activity).toBeGreaterThanOrEqual(0);
    expect(terminal).toBeGreaterThan(activity);

    // The quiet selected label rides on both non-hero triggers.
    expect(src.match(/selectedStyle={quietSelectedLabel}/g)?.length).toBe(2);
    // …and their icons override the bar's violet selected color.
    expect(src.match(/selectedColor={Palette\.textPrimary}/g)?.length).toBe(2);

    // No brand-violet selected chrome hides inside the Activity/Tools spans.
    for (const [start, end] of [
      [activity, terminal],
      [terminal, home > terminal ? home : src.length],
    ] as const) {
      const span = src.slice(start, end);
      expect(span).not.toContain('accentWarm');
      expect(span).not.toContain('Palette.accent');
    }

    // The quiet label resolves cool white on the resting medium weight.
    expect(src).toContain('color: Palette.textPrimary');
    expect(src).toContain("fontWeight: '500'");

    // Chat itself stays on the inherited violet lift — no quiet override.
    const chat = src.slice(src.indexOf('<NativeTabs.Trigger name="chat">'), activity);
    expect(chat).not.toContain('selectedColor=');
    expect(chat).not.toContain('quietSelectedLabel');
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
