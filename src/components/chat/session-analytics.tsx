import { useId, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Polygon, Polyline, Stop } from 'react-native-svg';

import { Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { formatCost, formatRelativeTime, formatTokenCount } from '@/lib/format';
import {
  relativeMeter,
  sessionUsage,
  spendWindowCopy,
  weekBuckets,
  type SessionUsageInput,
} from '@/lib/gateway/session-analytics';

const SPARK_H = 56;

export function SessionAnalytics({
  session,
  sessions,
  rowCount,
  messageCount,
  lastActive,
}: {
  session: SessionUsageInput;
  sessions: SessionUsageInput[];
  /**
   * Rows the read that produced `sessions` held (`SessionSpendRead.rowCount`),
   * not `sessions.length`: a row with nothing to parse is dropped from the
   * fold, so the caption must read the count the read was made at or a capped
   * window that carried one such row would claim no bound.
   */
  rowCount: number;
  messageCount?: number;
  /** When this conversation last moved, for the footer line. */
  lastActive?: number;
}) {
  const tokens = useTokens();
  const [now] = useState(() => Date.now());
  const [width, setWidth] = useState(0);
  const gradientId = `usage-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const usage = sessionUsage(session);
  const buckets = useMemo(() => weekBuckets(sessions, now), [now, sessions]);
  const weekTokenPeak = Math.max(...buckets.map((bucket) => bucket.tokens), 0);
  const weekCostPeak = Math.max(...buckets.map((bucket) => bucket.costUsd), 0);
  const tokenMeter = relativeMeter(usage.tokens, weekTokenPeak);
  const costMeter = relativeMeter(usage.costUsd ?? 0, weekCostPeak);
  const line = useMemo(
    () => (width > 0 ? sparklinePoints(buckets.map((bucket) => bucket.tokens), width, SPARK_H) : null),
    [buckets, width],
  );
  const footer = [
    typeof messageCount === 'number' ? `${messageCount} ${messageCount === 1 ? 'message' : 'messages'}` : undefined,
    lastActive ? `active ${formatRelativeTime(lastActive)}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={[styles.panel, { backgroundColor: tokens.backgroundInset, borderTopColor: tokens.specular }]}>
      {/* This conversation, as two figures in the display serif: what it has
          used, each with a hairline showing its share of the week's peak. */}
      <View style={styles.figures}>
        <Figure
          value={formatTokenCount(usage.tokens)}
          label="tokens"
          ratio={tokenMeter.ratio}
          track={tokens.backgroundRaised}
          fill={tokens.accent}
        />
        <Figure
          value={usage.costUsd != null ? formatCost(usage.costUsd) : '—'}
          label="cost"
          ratio={usage.costUsd == null ? 0 : costMeter.ratio}
          track={tokens.backgroundRaised}
          fill={tokens.accent}
        />
      </View>

      {/* The week: a line with its light pooled under it, and today as the
          one glowing point at its end. */}
      <View style={styles.chart} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        {width > 0 ? (
          <Svg width={width} height={SPARK_H}>
            <Defs>
              <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={tokens.accent} stopOpacity={0.3} />
                <Stop offset="1" stopColor={tokens.accent} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            {line ? (
              <>
                <Polygon points={`0,${SPARK_H} ${line.points} ${width},${SPARK_H}`} fill={`url(#${gradientId})`} />
                <Polyline
                  points={line.points}
                  fill="none"
                  stroke={tokens.accent}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <Circle cx={line.last.x} cy={line.last.y} r={7} fill={tokens.accentGlow} />
                <Circle cx={line.last.x} cy={line.last.y} r={3} fill={tokens.textPrimary} />
              </>
            ) : (
              <Polyline
                points={`0,${SPARK_H - 1} ${width},${SPARK_H - 1}`}
                fill="none"
                stroke={tokens.border}
                strokeWidth={StyleSheet.hairlineWidth}
              />
            )}
          </Svg>
        ) : null}
      </View>

      <View style={styles.footer}>
        <Text variant="micro" color="tertiary">
          {spendWindowCopy(rowCount)}
        </Text>
        {footer ? (
          <Text variant="micro" color="tertiary" numberOfLines={1} style={styles.footerRest}>
            {footer}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function sparklinePoints(
  values: number[],
  width: number,
  height: number,
): { points: string; last: { x: number; y: number } } | null {
  const peak = Math.max(...values, 0);
  if (peak === 0) return null;
  const last = values.length - 1;
  // A little room at each end so today's glowing point is never clipped.
  const inset = 8;
  const span = Math.max(1, width - inset * 2);
  const coords = values.map((value, index) => ({
    x: inset + (last === 0 ? 0 : (index / last) * span),
    y: height - (value / peak) * (height - 12) - 6,
  }));
  return {
    points: coords.map(({ x, y }) => `${x},${y}`).join(' '),
    last: coords[coords.length - 1],
  };
}

function Figure({
  value,
  label,
  ratio,
  track,
  fill,
}: {
  value: string;
  label: string;
  ratio: number;
  track: string;
  fill: string;
}) {
  return (
    <View style={styles.figure}>
      <Text variant="display" style={styles.numeral}>
        {value}
      </Text>
      <Text variant="caption" color="tertiary">
        {label}
      </Text>
      <View style={[styles.track, { backgroundColor: track }]}>
        <View style={[styles.fill, { width: `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`, backgroundColor: fill }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: Spacing.three,
    padding: Spacing.three,
    marginBottom: Spacing.three,
    borderRadius: Radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  figures: {
    flexDirection: 'row',
    gap: Spacing.four,
  },
  figure: {
    flex: 1,
    gap: 2,
  },
  numeral: {
    fontSize: 34,
    lineHeight: 38,
    fontVariant: ['tabular-nums'],
  },
  track: {
    height: 2,
    marginTop: Spacing.one,
    borderRadius: Radius.full,
    overflow: 'hidden',
  },
  fill: {
    height: 2,
    borderRadius: Radius.full,
  },
  chart: {
    height: SPARK_H,
    alignSelf: 'stretch',
  },
  footer: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  footerRest: {
    flexShrink: 1,
  },
});
