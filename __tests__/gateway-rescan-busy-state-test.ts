declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSectionSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'gateway', 'gateway-management-section.tsx'].join(SEP),
    'utf8',
  );
}

// The Rescan pressable (gateway-management-section.tsx:62) fires
// `discovery.rescan` and flips its label on
// `discovery.status === 'scanning'` — but carried no accessibilityState,
// so a screen-reader user heard a flat "button" with no busy readout
// while a sighted user saw "Scanning…".
describe('gate setup Rescan announces its scanning state', () => {
  test('the Rescan pressable declares accessibilityState.busy bound to the scanning status', () => {
    const src = readSectionSource();
    const rescanBlock = src.match(
      /onPress=\{discovery\.rescan\}[\s\S]*?<\/Pressable>/,
    )?.[0];
    expect(rescanBlock).toBeDefined();
    expect(rescanBlock).toMatch(
      /accessibilityState=\{\{\s*busy:\s*discovery\.status === 'scanning'\s*\}\}/,
    );
  });

  test('the Rescan keeps onPress={discovery.rescan} byte-identical', () => {
    const src = readSectionSource();
    expect(src).toMatch(/onPress=\{discovery\.rescan\}/);
  });

  test('the Scanning…/Rescan label ternary stays byte-identical', () => {
    const src = readSectionSource();
    expect(src).toContain(
      "{discovery.status === 'scanning' ? 'Scanning…' : 'Rescan'}",
    );
  });

  test('the unavailable and empty-list branches are untouched', () => {
    const src = readSectionSource();
    expect(src).toContain('Local discovery needs a native build.');
    expect(src).toContain(
      "{discovery.status === 'scanning' ? 'Scanning the local network…' : 'No nearby gateways found.'}",
    );
  });

  test('the sibling Add-gateway link carries no accessibilityState', () => {
    const src = readSectionSource();
    const addBlock = src.match(
      /href="\/gateway\/add"[\s\S]*?<\/Link>/,
    )?.[0];
    expect(addBlock).toBeDefined();
    expect(addBlock).not.toContain('accessibilityState');
  });

  test('the file carries exactly 2 accessibilityState props', () => {
    const src = readSectionSource();
    const count = (src.match(/accessibilityState=/g) ?? []).length;
    expect(count).toBe(2);
  });
});
