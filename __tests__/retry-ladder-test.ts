import {
  AUTO_RETRY_BASE_DELAY_MS,
  AUTO_RETRY_MAX_DELAY_MS,
  autoRetryDelayMs,
  autoRetryPulse,
  describeAutoRetry,
} from '@/lib/connection/retry-ladder';

describe('autoRetryDelayMs', () => {
  test('the first schedule waits one base interval', () => {
    expect(autoRetryDelayMs(0)).toBe(12_000);
  });

  test('each consecutive failure doubles the wait until the cap', () => {
    // The ladder shape the provider loop actually rides: 12s x2 up to 5min.
    const expected = [12_000, 24_000, 48_000, 96_000, 192_000, 300_000];
    expected.forEach((delay, failures) => {
      expect(autoRetryDelayMs(failures)).toBe(delay);
    });
  });

  test('the cap holds at five minutes no matter how long the outage', () => {
    expect(AUTO_RETRY_MAX_DELAY_MS).toBe(300_000);
    expect(autoRetryDelayMs(6)).toBe(300_000);
    expect(autoRetryDelayMs(50)).toBe(300_000);
    expect(autoRetryDelayMs(5_000)).toBe(300_000);
  });

  test('a call-site floor keeps its deliberate first-attempt pacing', () => {
    // No candidates to probe at all: the site asks for a calmer first wait.
    expect(autoRetryDelayMs(0, 30_000)).toBe(30_000);
    expect(autoRetryDelayMs(0, 20_000)).toBe(20_000);
    expect(autoRetryDelayMs(0, 18_000)).toBe(18_000);
  });

  test('a floor never drags the ladder below its next rung', () => {
    // Once the doubling outruns the floor, the ladder wins.
    expect(autoRetryDelayMs(1, 20_000)).toBe(24_000);
    expect(autoRetryDelayMs(2, 30_000)).toBe(48_000);
  });

  test('a floor is still capped at five minutes', () => {
    expect(autoRetryDelayMs(0, 10 * 60 * 1000)).toBe(300_000);
  });

  test('hostile inputs clamp instead of exploding', () => {
    expect(autoRetryDelayMs(-3)).toBe(12_000);
    expect(autoRetryDelayMs(-3, 20_000)).toBe(20_000);
    // Fractional streaks floor to a whole rung (2.7 -> rung 2).
    expect(autoRetryDelayMs(2.7)).toBe(48_000);
  });

  test('delays are non-decreasing in the failure streak for every floor in use', () => {
    for (const floor of [AUTO_RETRY_BASE_DELAY_MS, 18_000, 20_000, 30_000]) {
      let previous = 0;
      for (let failures = 0; failures <= 8; failures += 1) {
        const delay = autoRetryDelayMs(failures, floor);
        expect(delay).toBeGreaterThanOrEqual(previous);
        expect(delay).toBeLessThanOrEqual(AUTO_RETRY_MAX_DELAY_MS);
        previous = delay;
      }
    }
  });
});

describe('autoRetryPulse', () => {
  test('the first pending retry reports attempt 1 at the base interval', () => {
    expect(autoRetryPulse(0)).toEqual({ attempt: 1, delayMs: 12_000, capped: false });
  });

  test('mid-ladder waits stay uncapped and count human ordinals', () => {
    expect(autoRetryPulse(2)).toEqual({ attempt: 3, delayMs: 48_000, capped: false });
    // A floor can shape the first wait without pretending the ladder capped.
    expect(autoRetryPulse(1, 20_000)).toEqual({ attempt: 2, delayMs: 24_000, capped: false });
    expect(autoRetryPulse(0, 30_000)).toEqual({ attempt: 1, delayMs: 30_000, capped: false });
  });

  test('a capped wait is marked so the UI can admit the slow heartbeat', () => {
    expect(autoRetryPulse(5)).toEqual({ attempt: 6, delayMs: AUTO_RETRY_MAX_DELAY_MS, capped: true });
    expect(autoRetryPulse(50)).toHaveProperty('capped', true);
  });

  test('hostile streaks still produce a displayable pulse', () => {
    expect(autoRetryPulse(-3)).toEqual({ attempt: 1, delayMs: 12_000, capped: false });
    // Fractional streaks floor like the ladder's rungs do (2.7 -> rung 2).
    expect(autoRetryPulse(2.7)).toEqual({ attempt: 3, delayMs: 48_000, capped: false });
  });
});

describe('describeAutoRetry', () => {
  test('short waits name the exact next-try delay', () => {
    expect(describeAutoRetry(autoRetryPulse(0))).toBe(
      'Reconnecting automatically - next try in 12s.',
    );
    expect(describeAutoRetry({ attempt: 2, delayMs: 30_000, capped: false })).toBe(
      'Reconnecting automatically - next try in 30s.',
    );
  });

  test('a capped ladder admits it has settled on the five-minute heartbeat', () => {
    expect(describeAutoRetry(autoRetryPulse(9))).toBe(
      'Gateway unreachable - Versutus keeps trying automatically every five minutes.',
    );
  });
});
