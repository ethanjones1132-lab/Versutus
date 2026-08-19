import { formatConnectedToastLabel, formatCost, formatDuration, formatTokenCount } from '@/lib/format';

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
