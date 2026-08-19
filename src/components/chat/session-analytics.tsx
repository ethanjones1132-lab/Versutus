import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';

import { Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { formatCost, formatTokenCount } from '@/lib/format';
import {
  relativeMeter,
  sessionUsage,
  weekBuckets,
  type SessionUsageInput,
} from '@/lib/gateway/session-analytics';

const SPARK_W = 220;
const SPARK_H = 36;

export function SessionAnalytics({
  session,
  sessions,
  messageCount,
}: {
  session: SessionUsageInput;
  sessions: SessionUsageInput[];
  messageCount?: number;
}) {
  const tokens = useTokens();
  const [now] = useState(() => Date.now());
  const usage = sessionUsage(session);
  const buckets = useMemo(() => weekBuckets(sessions, now), [now, sessions]);
  const weekTokenPeak = Math.max(...buckets.map((bucket) => bucket.tokens), 0);
  const weekCostPeak = Math.max(...buckets.map((bucket) => bucket.costUsd), 0);
  const tokenMeter = relativeMeter(usage.tokens, weekTokenPeak);
  const costMeter = relativeMeter(usage.costUsd ?? 0, weekCostPeak);
  const sparkPoints = sparklinePoints(
    buckets.map((bucket) => bucket.tokens),
    SPARK_W,
    SPARK_H,
  );

  return (
    <View style={styles.wrap}>
      <Meter
        label="Tokens"
        value={formatTokenCount(usage.tokens)}
        ratio={tokenMeter.ratio}
        track={tokens.backgroundInset}
        fill={tokens.accentWarm}
      />
      <Meter
        label="Cost"
        value={usage.costUsd != null ? formatCost(usage.costUsd) : '—'}
        ratio={usage.costUsd == null ? 0 : costMeter.ratio}
        track={tokens.backgroundInset}
        fill={tokens.accent}
      />
      <View style={styles.sparkBlock}>
        <Svg width={SPARK_W} height={SPARK_H} style={styles.spark}>
          {sparkPoints ? (
            <Polyline
              points={sparkPoints}
              fill="none"
              stroke={tokens.accentWarm}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : (
            <Polyline
              points={`0,${SPARK_H - 1} ${SPARK_W},${SPARK_H - 1}`}
              fill="none"
              stroke={tokens.border}
              strokeWidth={StyleSheet.hairlineWidth}
            />
          )}
        </Svg>
        <Text variant="micro" color="tertiary">
          Last 7 days · from recent sessions
        </Text>
      </View>
      {typeof messageCount === 'number' ? (
        <Text variant="caption" color="tertiary">
          {messageCount} messages
        </Text>
      ) : null}
    </View>
  );
}

function sparklinePoints(values: number[], width: number, height: number): string | null {
  const peak = Math.max(...values, 0);
  if (peak === 0) return null;
  const last = values.length - 1;
  return values
    .map((value, index) => {
      const x = last === 0 ? 0 : (index / last) * width;
      const y = height - (value / peak) * (height - 2) - 1;
      return `${x},${y}`;
    })
    .join(' ');
}

function Meter({
  label,
  value,
  ratio,
  track,
  fill,
}: {
  label: string;
  value: string;
  ratio: number;
  track: string;
  fill: string;
}) {
  return (
    <View style={styles.meter}>
      <View style={styles.meterLabel}>
        <Text variant="micro" color="tertiary">
          {label}
        </Text>
        <Text variant="caption">{value}</Text>
      </View>
      <View style={[styles.track, { backgroundColor: track }]}>
        <View style={[styles.fill, { width: `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`, backgroundColor: fill }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: Spacing.two,
    paddingHorizontal: Spacing.one,
    paddingBottom: Spacing.two,
  },
  meter: {
    gap: Spacing.one,
  },
  meterLabel: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  track: {
    height: 4,
    borderRadius: Radius.full,
    overflow: 'hidden',
  },
  fill: {
    height: 4,
    borderRadius: Radius.full,
  },
  sparkBlock: {
    gap: Spacing.one,
    paddingTop: Spacing.one,
  },
  spark: {
    alignSelf: 'stretch',
  },
});
