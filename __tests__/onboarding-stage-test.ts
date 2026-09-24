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
  test('the hero rule, eyebrow, and scan strip use the brand violet tokens', () => {
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
    expect(onboarding).toContain('const ok = await setupFromPcAddress(pcAddress, token);');
    expect(onboarding).toContain('disabled={cta.locked || !validation.valid}');
    expect(onboarding).toContain('<Button label="Retry" onPress={() => void retryAutoConnect()} />');
    expect(onboarding).toContain("router.push('/gateway/add')");
  });

  test('the onboarding surfaces stay free of gold-as-brand roles', () => {
    for (const source of [onboarding, timeline, badge]) {
      expect(source).not.toMatch(/Palette\.gold|tokens\.gold/);
    }
    expect(Palette.accent).not.toBe(Palette.gold);
  });
});
