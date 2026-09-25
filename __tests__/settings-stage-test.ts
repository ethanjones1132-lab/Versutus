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
  test('section labels and the device glyph use the brand accent', () => {
    const src = settings();
    expect(src).not.toMatch(/accentWarm|accentWarmMuted|Palette\.gold|tokens\.gold/);
    const eyebrowCount = (src.match(/style=\{styles\.eyebrow\}/g) ?? []).length;
    expect(eyebrowCount).toBe(8);
    expect((src.match(/color="accent" style=\{styles\.eyebrow\}/g) ?? []).length).toBe(eyebrowCount);
    expect(src).toContain("color=\"accent\" />");
  });

  test('settings keeps flat, borderless hero, surface, and inset card material', () => {
    const src = settings();
    const shared = variants();
    expect(src).toContain('variant="hero"');
    expect(src).toContain('variant="surface"');
    expect(src).toContain('variant="inset"');
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
