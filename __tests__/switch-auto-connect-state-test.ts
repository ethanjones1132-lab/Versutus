declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readManagementSectionSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'gateway', 'gateway-management-section.tsx'].join(SEP),
    'utf8',
  );
}

// The Gateway auto-connect Switch (gateway-management-section.tsx:41) declares
// its purpose via `accessibilityLabel="Connect automatically on launch"` but
// never announces the checked state, so a VoiceOver/TalkBack user hears the
// label without an on/off readout. The Switch is the only <Switch> in the
// codebase (grep confirms a single site), so this is a one-control fix.
describe('Gateway auto-connect Switch screen-reader state', () => {
  test('the Switch declares accessibilityState.checked bound to settings.autoConnect', () => {
    const src = readManagementSectionSource();
    // The Switch block at :41-47 must carry an accessibilityState prop whose
    // checked value mirrors the value prop's settings.autoConnect binding.
    expect(src).toMatch(
      /<Switch[\s\S]*?value=\{settings\.autoConnect\}[\s\S]*?accessibilityState=\{\{\s*checked:\s*settings\.autoConnect\s*\}\}[\s\S]*?\/>/,
    );
  });

  test('the Switch keeps accessibilityLabel byte-identical to the previous wiring', () => {
    const src = readManagementSectionSource();
    expect(src).toContain('accessibilityLabel="Connect automatically on launch"');
  });

  test('the Switch keeps value, onValueChange, trackColor, and thumbColor byte-identical', () => {
    const src = readManagementSectionSource();
    // The visible Switch UI must be untouched: the value prop, the toggle
    // handler, and the track/thumb colors are what the operator sees on
    // screen, and the new accessibilityState must not regress any of them.
    expect(src).toContain('value={settings.autoConnect}');
    expect(src).toContain('onValueChange={(value) => void setAutoConnect(value)}');
    expect(src).toContain('trackColor={{ true: tokens.accent, false: tokens.border }}');
    expect(src).toContain('thumbColor={tokens.textPrimary}');
  });

  test('accessibilityState appears on the Switch and is not duplicated on surrounding Pressables', () => {
    const src = readManagementSectionSource();
    // Only the Switch carries an accessibilityState prop. The Pressable
    // controls in the same file (the Rescan and Add gateway links) must
    // remain accessibilityRole="button" with no state to announce.
    const switchBlock = src.match(/<Switch[\s\S]*?\/>/)?.[0];
    expect(switchBlock).toBeDefined();
    expect(switchBlock).toMatch(/accessibilityState=\{\{\s*checked:\s*settings\.autoConnect\s*\}\}/);
  });
});