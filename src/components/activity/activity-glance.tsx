import { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, { Easing, FadeInDown } from 'react-native-reanimated';
import Svg, { Circle, Defs, Line, LinearGradient, RadialGradient, Stop } from 'react-native-svg';

import { PressableScale, Text } from '@/components/ui';
import { Motion, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { useBotCrest } from '@/hooks/use-crest-fleet';
import { RIBBON_TICKS, dayRibbon, glanceFigures, type RibbonBead } from '@/lib/activity/glance';
import type { ActivityRun } from '@/lib/gateway/runs';
import { haptics } from '@/lib/haptics';
import { BRAND_TONE } from '@/lib/stage/lamp';

const BEAD = 12;
const GLOW = 34;
const RIBBON_HEIGHT = GLOW;

/** One run on the ribbon: its crest's two stops, a soft glow of its lit stop. */
function Bead({ bead, index }: { bead: RibbonBead; index: number }) {
  const tokens = useTokens();
  const crest = useBotCrest(bead.botId ?? '');
  const tone = bead.botId ? crest.tone : BRAND_TONE;
  const id = `bead-${bead.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const r = BEAD / 2;
  const c = GLOW / 2;
  // A working run glows fuller; a settled one is a quiet ember. The waiting
  // run's amber ring is the one attention mark on the ribbon.
  const glow = bead.state === 'working' ? 0.55 : bead.state === 'waiting' ? 0.4 : 0.26;
  return (
    <Animated.View
      entering={FadeInDown.delay(120 + index * 45)
        .duration(Motion.duration.normal)
        .easing(Easing.bezier(0, 0, 0.2, 1))
        .withInitialValues({ opacity: 0, transform: [{ translateY: 6 }] })}
      style={styles.bead}>
      <Svg width={GLOW} height={GLOW}>
        <Defs>
          <RadialGradient id={`${id}-glow`} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={tone.from} stopOpacity={glow} />
            <Stop offset="1" stopColor={tone.from} stopOpacity={0} />
          </RadialGradient>
          <LinearGradient id={`${id}-body`} x1="0.15" y1="0" x2="0.85" y2="1">
            <Stop offset="0" stopColor={tone.from} />
            <Stop offset="1" stopColor={tone.to} />
          </LinearGradient>
        </Defs>
        <Circle cx={c} cy={c} r={c} fill={`url(#${id}-glow)`} />
        <Circle cx={c} cy={c} r={r} fill={`url(#${id}-body)`} />
        {bead.state === 'waiting' ? (
          <Circle cx={c} cy={c} r={r + 3} fill="none" stroke={tokens.statusConnecting} strokeWidth={1.5} />
        ) : null}
      </Svg>
    </Animated.View>
  );
}

/**
 * The top of Activity: three figures set in the display serif, and beneath
 * them the last day as a ribbon of light — every run a bead in its Bot's
 * colour, placed at the hour it started, now at the right. A tap on the
 * ribbon opens Runs.
 */
export function ActivityGlance({
  pendingApprovals,
  runs,
  now,
  onOpenRuns,
  onOpenRun,
}: {
  pendingApprovals: number;
  runs: ActivityRun[];
  now: number;
  /** A tap on the ribbon's line: the whole day's runs. */
  onOpenRuns: () => void;
  /** A tap on one bead: that run, found and lit in Runs. */
  onOpenRun?: (runId: string) => void;
}) {
  const tokens = useTokens();
  const [width, setWidth] = useState(0);
  const figures = glanceFigures(pendingApprovals, runs, now);
  const beads = dayRibbon(runs, now);
  const summary = figures.map((figure) => `${figure.value} ${figure.label}`).join(', ');

  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);
  // Beads sit inside the track so the first and last never clip their glow.
  const inset = GLOW / 2;
  const span = Math.max(0, width - GLOW);

  return (
    <View style={styles.root}>
      <View style={styles.figures} accessible accessibilityLabel={summary}>
        {figures.map((figure) => (
          <View key={figure.key} style={styles.figure}>
            <Text variant="display" color={figure.value > 0 ? 'primary' : 'tertiary'} style={styles.numeral}>
              {String(figure.value)}
            </Text>
            <View style={styles.figureLabel}>
              {figure.key === 'needs-you' && figure.value > 0 ? (
                <View style={[styles.mark, { backgroundColor: tokens.statusConnecting }]} />
              ) : null}
              {figure.key === 'failed' ? (
                <View style={[styles.mark, { backgroundColor: tokens.statusDisconnected }]} />
              ) : null}
              <Text variant="caption" color="tertiary">
                {figure.label}
              </Text>
            </View>
          </View>
        ))}
      </View>

      {/* When each bead opens its own run, the line is not also a button — a
          button inside a button is neither, for a screen reader or the web. */}
      <RibbonFrame
        onPress={onOpenRun ? undefined : onOpenRuns}
        label={`The last day: ${beads.length} ${beads.length === 1 ? 'run' : 'runs'}. Open runs.`}>
        <View style={styles.ribbon} onLayout={onLayout}>
          {width > 0 ? (
            <Svg width={width} height={RIBBON_HEIGHT} style={StyleSheet.absoluteFill}>
              <Defs>
                {/* The day fades in from the left: yesterday is dim, now is lit. */}
                {/* User-space units: a horizontal line has no height, so a
                    bounding-box gradient on it would draw nothing at all. */}
                <LinearGradient
                  id="ribbon-track"
                  gradientUnits="userSpaceOnUse"
                  x1={inset}
                  y1={0}
                  x2={width - inset}
                  y2={0}>
                  <Stop offset="0" stopColor={tokens.textTertiary} stopOpacity={0} />
                  <Stop offset="1" stopColor={tokens.textTertiary} stopOpacity={0.55} />
                </LinearGradient>
              </Defs>
              <Line
                x1={inset}
                y1={RIBBON_HEIGHT / 2}
                x2={width - inset}
                y2={RIBBON_HEIGHT / 2}
                stroke="url(#ribbon-track)"
                strokeWidth={1}
              />
              {RIBBON_TICKS.map((tick) => (
                <Line
                  key={tick.label}
                  x1={inset + tick.at * span}
                  y1={RIBBON_HEIGHT / 2 - 3}
                  x2={inset + tick.at * span}
                  y2={RIBBON_HEIGHT / 2 + 3}
                  stroke={tokens.textTertiary}
                  strokeOpacity={0.6}
                  strokeWidth={1}
                />
              ))}
              <Circle cx={width - inset} cy={RIBBON_HEIGHT / 2} r={2} fill={tokens.textSecondary} />
            </Svg>
          ) : null}
          {width > 0
            ? beads.map((bead, index) => (
                <View key={bead.id} style={[styles.beadSlot, { left: inset + bead.at * span - GLOW / 2 }]}>
                  {onOpenRun ? (
                    <PressableScale
                      onPress={async () => {
                        await haptics.selection();
                        onOpenRun(bead.id);
                      }}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel={`Open this run (${bead.state === 'waiting' ? 'waiting for you' : bead.state === 'working' ? 'working' : 'finished'})`}>
                      <Bead bead={bead} index={index} />
                    </PressableScale>
                  ) : (
                    <Bead bead={bead} index={index} />
                  )}
                </View>
              ))
            : null}
        </View>
        <View style={styles.axis}>
          <Text variant="micro" color="tertiary">
            A day ago
          </Text>
          {width > 0
            ? RIBBON_TICKS.map((tick) => (
                <Text
                  key={tick.label}
                  variant="micro"
                  color="tertiary"
                  style={[styles.tick, { left: inset + tick.at * span - 12 }]}>
                  {tick.label}
                </Text>
              ))
            : null}
          <Text variant="micro" color="tertiary">
            Now
          </Text>
        </View>
      </RibbonFrame>
    </View>
  );
}

function RibbonFrame({
  onPress,
  label,
  children,
}: {
  onPress?: () => void;
  label: string;
  children: React.ReactNode;
}) {
  if (!onPress) return <View style={styles.ribbonPress}>{children}</View>;
  return (
    <PressableScale
      onPress={async () => {
        await haptics.selection();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.ribbonPress}>
      {children}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: Spacing.three,
  },
  figures: {
    flexDirection: 'row',
    gap: Spacing.four,
    paddingHorizontal: Spacing.one,
  },
  figure: {
    gap: 2,
  },
  numeral: {
    fontSize: 44,
    lineHeight: 48,
    fontVariant: ['tabular-nums'],
  },
  figureLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  mark: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  ribbonPress: {
    gap: Spacing.one,
  },
  ribbon: {
    height: RIBBON_HEIGHT,
  },
  beadSlot: {
    position: 'absolute',
    top: 0,
    width: GLOW,
    height: GLOW,
  },
  bead: {
    width: GLOW,
    height: GLOW,
  },
  axis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: GLOW / 2 - 4,
  },
  tick: {
    position: 'absolute',
    width: 24,
    textAlign: 'center',
  },
});
