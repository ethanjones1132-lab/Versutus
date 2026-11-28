// The design comment above `Typography` says titles are set in Instrument
// Serif, and the real consumers (src/components/ui/Text.tsx) use
// `FontFamily.serif`. A second `Fonts` export answered 'ui-serif' on iOS and
// 'serif' elsewhere — a system face, not the brand one — so a reader who
// picked `Fonts.serif` got the wrong family with no error. The tokens module
// keeps one serif answer: `FontFamily.serif`.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readTokens(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'constants', 'tokens.ts'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('the token module names one serif family', () => {
  test('there is no second `Fonts` map to pick a system serif from', () => {
    const src = readTokens();
    expect(src).not.toMatch(/export const Fonts\b/);
    expect(src).not.toContain("serif: 'ui-serif'");
    expect(src).not.toContain("serif: 'serif'");
  });

  test('FontFamily.serif is the Instrument Serif face the design comment names', () => {
    expect(readTokens()).toContain("serif: 'InstrumentSerif_400Regular',");
  });
});
