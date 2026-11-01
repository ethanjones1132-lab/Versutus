import {
  formatClockTime,
  formatConnectedToastLabel,
  formatCost,
  formatDuration,
  formatTokenCount,
} from '@/lib/format';

describe('display formatters', () => {
  test('formats tokens and cost compactly', () => {
    expect(formatTokenCount(1250)).toBe('1.3k');
    expect(formatTokenCount(2_000_000)).toBe('2.0M');
    expect(formatCost(0.0042)).toBe('$0.0042');
    expect(formatCost(2)).toBe('$2.00');
  });

  test('formats elapsed durations', () => {
    expect(formatDuration(7_000)).toBe('0:07');
    expect(formatDuration(63_000)).toBe('1:03');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
  });
});

describe('formatClockTime', () => {
  test('a non-finite timestamp returns empty rather than Invalid Date', () => {
    expect(formatClockTime(Number.POSITIVE_INFINITY)).toBe('');
    expect(formatClockTime(Number.NEGATIVE_INFINITY)).toBe('');
    expect(formatClockTime(Number.NaN)).toBe('');
  });

  test('a finite millisecond timestamp still returns a clock string', () => {
    const label = formatClockTime(1_700_000_000_000);
    expect(label).not.toBe('');
    expect(label).not.toMatch(/invalid/i);
  });
});

describe('formatTokenCount unit boundaries', () => {
  test('a rounded value that reaches 1000 promotes to the next unit', () => {
    expect(formatTokenCount(999_500)).toBe('1.0M');
    expect(formatTokenCount(999_950)).toBe('1.0M');
    expect(formatTokenCount(999_999)).toBe('1.0M');
    expect(formatTokenCount(999_950_000)).toBe('1.0B');
    expect(formatTokenCount(999_999_999)).toBe('1.0B');
    expect(formatTokenCount(999_950_000_000)).toBe('1.0T');
  });

  test('values below the rounding boundary keep their own unit', () => {
    expect(formatTokenCount(999_499)).toBe('999k');
    expect(formatTokenCount(999_949_999)).toBe('999.9M');
    expect(formatTokenCount(999_900_000_000)).toBe('999.9B');
  });

  test('the sub-thousand case promotes instead of printing raw 1000', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(999.4)).toBe('999');
    expect(formatTokenCount(999.5)).toBe('1.0k');
    expect(formatTokenCount(999.6)).toBe('1.0k');
  });

  test('promoted output matches the next unit exactly at its threshold', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.0M');
    expect(formatTokenCount(1_000_000_000)).toBe('1.0B');
    expect(formatTokenCount(1_000_000_000_000)).toBe('1.0T');
  });

  test('existing per-unit precision is preserved', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(-5)).toBe('0');
    expect(formatTokenCount(Number.NaN)).toBe('0');
    expect(formatTokenCount(1200)).toBe('1.2k');
    expect(formatTokenCount(25_000)).toBe('25k');
    expect(formatTokenCount(2_500_000)).toBe('2.5M');
    expect(formatTokenCount(25_000_000)).toBe('25.0M');
    expect(formatTokenCount(1_200_000_000)).toBe('1.2B');
  });
});

describe('formatConnectedToastLabel', () => {
  test('joins name and version with a real middle dot', () => {
    expect(formatConnectedToastLabel({ gatewayName: 'Studio', version: '0.5.2' })).toBe(
      'Connected · Studio · v0.5.2',
    );
    expect(formatConnectedToastLabel({ gatewayName: 'Studio' })).toBe('Connected · Studio');
    expect(formatConnectedToastLabel({ version: '1.0' })).toBe('Connected · v1.0');
    expect(formatConnectedToastLabel({})).toBe('Connected');
  });

  test('never emits an escaped unicode sequence', () => {
    const label = formatConnectedToastLabel({ gatewayName: 'Gate', version: '2' });
    expect(label).not.toContain('\\u00b7');
    expect(label).toContain('\u00b7');
  });
});
