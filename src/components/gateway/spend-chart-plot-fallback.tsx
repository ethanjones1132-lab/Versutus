import { StyleSheet, View } from 'react-native';

import { Radius } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { WeekBucket } from '@/lib/gateway/session-analytics';
import { SPEND_CHART_FRAME, spendChartBars } from '@/lib/gateway/spend-chart';

export type SpendChartPlotProps = {
  /** The seven days `weekBuckets` folded — one bar each, in order. */
  buckets: WeekBucket[];
};

/**
 * P5's 7-day chart in plain views: what web bundles, and what a native Skia
 * mount falls back to when it throws.
 *
 * Both this and the Skia plot paint `spendChartBars` in `SPEND_CHART_FRAME`,
 * so the same week is the same picture on either path and neither works out
 * the week a second time. A bar of zero height is a day with nothing in it:
 * it is drawn, at nothing, rather than given a minimum that would read as
 * spend.
 */
export function SpendChartPlotFallback({ buckets }: SpendChartPlotProps) {
  const tokens = useTokens();
  const bars = spendChartBars(buckets, SPEND_CHART_FRAME);

  return (
    <View
      style={[
        styles.plot,
        {
          width: SPEND_CHART_FRAME.width,
          height: SPEND_CHART_FRAME.height,
          borderBottomColor: tokens.border,
        },
      ]}>
      {bars.map((bar) => (
        <View
          key={bar.startMs}
          style={[
            styles.bar,
            { left: bar.x, width: bar.width, height: bar.height, backgroundColor: tokens.accentWarm },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  plot: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bar: {
    position: 'absolute',
    bottom: 0,
    borderTopLeftRadius: Radius.xs,
    borderTopRightRadius: Radius.xs,
  },
});
