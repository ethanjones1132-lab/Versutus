import { StyleSheet } from 'react-native';

import { Card, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { spendWindowCopy, type WeekBucket } from '@/lib/gateway/session-analytics';

import { SpendChartPlot } from './spend-chart-plot';

/**
 * P5's 7-day chart: the week `weekBuckets` folded, as one bar per day.
 *
 * The fold and the geometry live in `src/lib/gateway/**` — the buckets come
 * in from the screen's one catalogue read and `spendChartBars` places them —
 * so this is only the surface around them, and the plot is the platform's
 * (Skia on native, plain views on web).
 *
 * The bars are tokens, and the chart says so: cost is nullable on a read
 * (`sessionUsage` keeps an absent cost absent), so a cost-scaled chart would
 * be a week of zero-height bars on a gateway that reports tokens only. The
 * window line under it is the shipped `spendWindowCopy`, which names the cap
 * the read stopped at, and never reads as a result the gateway reported.
 */
export function SpendChart({ buckets, rowCount }: { buckets: WeekBucket[]; rowCount: number }) {
  return (
    <Card variant="surface" padding={Spacing.three} style={styles.card}>
      <Text variant="micro" color="tertiary">
        Tokens per day
      </Text>
      <SpendChartPlot buckets={buckets} />
      <Text variant="micro" color="tertiary">
        {spendWindowCopy(rowCount)}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.two,
  },
});
