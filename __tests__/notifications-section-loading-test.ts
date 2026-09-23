// ─── Settings → Notifications loading honesty ──────────────────────────────
// While the Gate's stored prefs are in flight the switch cards must not
// render the all-false DEFAULT_PREFS as if they were the answer, and a
// refusal must surface above the controls rather than as a trailing caption.
// Pinned off the source so a refactor that reorders the branches fails here.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

const section = () => readSource('src', 'components', 'gateway', 'notifications-section.tsx');
const hook = () => readSource('src', 'hooks', 'use-notification-preferences.ts');

describe('notifications section loading honesty', () => {
  test('the switch cards are held behind Skeletons while the prefs are in flight', () => {
    const source = section();
    expect(source).toMatch(/loading\s*\?/);
    expect(source).toMatch(/loading\s*\?[\s\S]{0,400}<Skeleton/);
    expect(source).not.toContain('Loading preferences from the Gate…');
  });

  test('the refusal surfaces above the switch cards, not after them', () => {
    const source = section();
    const errorIdx = source.indexOf('{error ?');
    // The hero Relay card is the first switch card of the main return (the
    // disconnected inset card above it has no switches).
    const firstSwitchCardIdx = source.indexOf('variant="hero"');
    expect(errorIdx).toBeGreaterThan(-1);
    expect(firstSwitchCardIdx).toBeGreaterThan(-1);
    expect(errorIdx).toBeLessThan(firstSwitchCardIdx);
    expect(source).toContain('<ErrorCard');
  });

  test('the hook reports the first read in flight from the first paint', () => {
    expect(hook()).toContain('const [loading, setLoading] = useState(true)');
  });

  test('a disconnected hook settles the loading flag instead of spinning forever', () => {
    expect(hook()).toMatch(
      /if \(!connected\) \{\s*(?:\/\/[^\n]*\n\s*)?setLoading\(false\);\s*return;\s*\}/,
    );
  });

  test('the ready branch keeps every switch card and the test round trip', () => {
    const source = section();
    for (const pin of [
      'Push notifications',
      'Rich message text',
      'Home-screen widget updates',
      'Quiet hours',
      'Bot filter',
      'Send test notification',
      'Let approval notices through during quiet hours',
    ]) {
      expect(source).toContain(pin);
    }
  });
});
