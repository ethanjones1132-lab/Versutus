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

const onboarding = readSource('src', 'components', 'onboarding', 'onboarding-screen.tsx');
const timeline = readSource('src', 'components', 'connection-timeline.tsx');
const badge = readSource('src', 'components', 'connection-badge.tsx');

describe('onboarding first-connection chrome', () => {
  test('the hero rule and active check state use the brand violet tokens', () => {
    expect(onboarding).toContain('backgroundColor: tokens.accentMuted');
    expect(onboarding).toContain('color="accent"');
    expect(onboarding).toContain('color={tokens.accent}');
    expect(onboarding).not.toMatch(/accentWarm|accentWarmMuted/);
  });

  test('the timeline reserves semantic failure red and brand violet for active progress', () => {
    expect(timeline).toContain("color={isActive ? (failed ? 'statusDisconnected' : 'accent')");
    expect(timeline).toContain('? tokens.statusDisconnected');
    expect(timeline).toContain('? tokens.accent');
    expect(timeline).not.toMatch(/accentWarm|accentWarmMuted/);
  });

  test('the pairing badge uses brand violet while retaining semantic status dots', () => {
    expect(badge).toContain('variant="chip"');
    expect(badge).toContain('borderColor: tokens.accent');
    expect(badge).toContain('isPairing ? tokens.accent : tokens.textSecondary');
    expect(badge).toContain("case 'pairing':");
    expect(badge).toContain('return tokens.statusPairing;');
    expect(badge).not.toMatch(/accentWarm|accentWarmMuted/);
  });

  test('the onboarding flow keeps its validation, retry, and connect behavior', () => {
    expect(onboarding).toContain('const result = await setupFromPcAddress(pcAddress, token);');
    expect(onboarding).toContain("if (result.kind === 'connected')");
    expect(onboarding).toContain('disabled={cta.locked || !validation.valid}');
    expect(onboarding).toContain("label={retrying ? 'Trying again…' : 'Try again'}");
    expect(onboarding).toContain("router.push('/gateway/add')");
  });

  test('the first-run hero gives a concise manual address instruction', () => {
    expect(onboarding).toContain('Enter your PC&rsquo;s Tailscale name, IP, or local address below.');
    expect(onboarding).not.toContain('This build can’t find PCs automatically.');
    expect(onboarding).not.toContain('Automatic local discovery is unavailable in this build.');
    expect(onboarding).not.toContain('let Versutus find it');
    expect(onboarding).not.toContain('checks nearby networks');
    expect(onboarding).not.toContain('ScanningStrip');
    expect(onboarding).not.toContain('ConnectionTimeline');
  });

  test('the collapsed Gate guide follows the connection form and links to the repository README', () => {
    expect(onboarding.indexOf('Connect your PC')).toBeLessThan(onboarding.indexOf('Set up the Gate'));
    expect(onboarding).toContain('const [showGateSetup, setShowGateSetup] = useState(false)');
    expect(onboarding).toContain('accessibilityState={{ expanded: showGateSetup }}');
    expect(onboarding).toContain('aria-expanded={showGateSetup}');
    expect(onboarding).toContain('https://github.com/ethanjones1132-lab/Versutus#versutus-gate');
  });

  test('Gate setup exposes supported, copyable start commands and readiness guidance', () => {
    expect(onboarding).toContain('node gate/cli.mjs start --host 0.0.0.0 --allow-plaintext');
    expect(onboarding).toContain('node gate/cli.mjs service install --host 0.0.0.0 --allow-plaintext');
    expect(onboarding).not.toContain('--host 100.x.y.z');
    expect(onboarding).toContain('Clipboard.setStringAsync(command)');
    expect(onboarding).toContain('sends gateway keys without encryption');
    expect(onboarding).toContain('open Gate setup to add a provider or connect a command-line tool');
  });

  test('the onboarding surfaces stay free of gold-as-brand roles', () => {
    for (const source of [onboarding, timeline, badge]) {
      expect(source).not.toMatch(/Palette\.gold|tokens\.gold/);
    }
    expect(Palette.accent).not.toBe(Palette.gold);
  });
});
