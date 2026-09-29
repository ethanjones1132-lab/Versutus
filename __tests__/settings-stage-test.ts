declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function settings(): string {
  return readSource('src', 'app', 'gateway', 'settings.tsx');
}

function variants(): string {
  return readSource('src', 'components', 'ui', 'glass-variants.ts');
}

describe('gateway settings inherits the quiet violet stage', () => {
  test('settings is grouped rows under quiet section labels, never a violet eyebrow stack', () => {
    const src = settings();
    expect(src).not.toMatch(/accentWarm|accentWarmMuted|Palette\.gold|tokens\.gold/);
    // Visual direction: Settings is grouped rows (label · value · chevron),
    // named by sentence-case section headers — no ALL-CAPS violet eyebrows.
    expect(src).not.toContain('style={styles.eyebrow}');
    expect(src).not.toContain("textTransform: 'uppercase'");
    for (const title of ['Gate', 'Privacy', 'Voice', 'Notifications', 'Approvals', 'This device', 'This build']) {
      expect(src).toContain(`<SectionHeader title="${title}" />`);
    }
    expect(src).toContain('<RowGroup>');
    expect(src).toContain('<RowGroupRow');
    expect(src).toContain("color={selected ? 'accent' : 'textTertiary'}");
  });

  test('settings keeps flat, borderless surface material', () => {
    const src = settings();
    const shared = variants();
    // Cards on the settings page rest on the lit stage panel (the elevated
    // step in the dark, lamplight through it near the top).
    expect(src).toContain('variant="stage"');
    expect(src).not.toContain('glass');
    // S4b: the settings stacks are the reason the wireframe look showed up
    // here first, so every shared variant they lean on must ship borderWidth 0
    // alongside its cool hairline colour.
    expect(shared).toMatch(
      /hero: \{[^}]*backgroundColor: Palette\.backgroundRaised,[^}]*borderColor: Palette\.borderStrong,[^}]*borderWidth: 0[^}]*\}/,
    );
    expect(shared).toMatch(
      /surface: \{[^}]*backgroundColor: Palette\.backgroundElevated,[^}]*borderColor: Palette\.border,[^}]*borderWidth: 0[^}]*\}/,
    );
    expect(shared).toMatch(
      /inset: \{[^}]*backgroundColor: Palette\.backgroundInset,[^}]*borderColor: Palette\.borderSubtle,[^}]*borderWidth: 0[^}]*\}/,
    );
  });

  test('the brand accent remains violet rather than metallic gold', () => {
    const tokens = readSource('src', 'constants', 'tokens.ts');
    expect(tokens).toContain("accent: '#8B7CFF'");
    expect(tokens).toContain("gold: '#D4AF37'");
    expect(settings()).not.toContain('#D4AF37');
  });
});
