import { relativeMeter, sessionUsage, weekBuckets } from '@/lib/gateway/session-analytics';

describe('sessionUsage', () => {
  test('sums tokens and prefers actual cost', () => {
    expect(
      sessionUsage({
        input_tokens: 100,
        output_tokens: 50,
        actual_cost_usd: 0.02,
        estimated_cost_usd: 0.99,
      }),
    ).toEqual({ tokens: 150, costUsd: 0.02 });
  });

  test('missing token fields count as 0 and missing costs are null', () => {
    expect(sessionUsage({})).toEqual({ tokens: 0, costUsd: null });
    expect(sessionUsage({ estimated_cost_usd: 1.5 })).toEqual({ tokens: 0, costUsd: 1.5 });
  });
});

describe('relativeMeter', () => {
  test('0/0 is ratio 0', () => {
    expect(relativeMeter(0, 0)).toEqual({ value: 0, peak: 0, ratio: 0 });
  });

  test('value above week max becomes the peak and ratio never exceeds 1', () => {
    expect(relativeMeter(10, 5)).toEqual({ value: 10, peak: 10, ratio: 1 });
    expect(relativeMeter(5, 10)).toEqual({ value: 5, peak: 10, ratio: 0.5 });
  });
});

describe('weekBuckets', () => {
  const noonOn = (year: number, monthIndex: number, day: number) =>
    new Date(year, monthIndex, day, 12, 0, 0).getTime();

  test('returns 7 local days ending today, oldest first', () => {
    const now = new Date(2026, 7, 19, 15, 0, 0).getTime();
    const buckets = weekBuckets([], now);
    expect(buckets).toHaveLength(7);
    expect(buckets[0].startMs).toBe(new Date(2026, 7, 13).getTime());
    expect(buckets[6].startMs).toBe(new Date(2026, 7, 19).getTime());
    expect(buckets.every((bucket) => bucket.tokens === 0 && bucket.costUsd === 0)).toBe(true);
  });

  test('groups by local day, skips missing timestamps, accepts unix seconds', () => {
    const now = new Date(2026, 7, 19, 15, 0, 0).getTime();
    const buckets = weekBuckets(
      [
        { last_active: noonOn(2026, 7, 19) / 1000, input_tokens: 10, output_tokens: 5, actual_cost_usd: 0.4 },
        { last_active: noonOn(2026, 7, 13), input_tokens: 20, output_tokens: 0, estimated_cost_usd: 0.1 },
        { last_active: noonOn(2026, 7, 12), input_tokens: 999, output_tokens: 0 },
        { input_tokens: 50, output_tokens: 50 },
      ],
      now,
    );
    expect(buckets[6].tokens).toBe(15);
    expect(buckets[6].costUsd).toBe(0.4);
    expect(buckets[0].tokens).toBe(20);
    expect(buckets[0].costUsd).toBe(0.1);
    expect(buckets.reduce((sum, bucket) => sum + bucket.tokens, 0)).toBe(35);
  });
});
