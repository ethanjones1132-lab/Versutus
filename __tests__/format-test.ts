import { formatCost, formatDuration, formatTokenCount } from '@/lib/format';

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
