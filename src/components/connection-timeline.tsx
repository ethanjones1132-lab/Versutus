import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Layout,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Text } from '@/components/ui';
import { Motion, Spacing } from '@/constants/tokens';
import { pulseTiming } from '@/lib/motion/presets';
import { useTokens } from '@/hooks/use-tokens';

export const CONNECTION_TIMELINE_STEPS = ['Search', 'Connect', 'Approve', 'Ready'] as const;
export const CONNECTION_TIMELINE_STEPS_LONG = ['Searching', 'Connecting', 'Pairing', 'Connected'] as const;

type ConnectionTimelineProps = {
  activeStep: number;
  failed?: boolean;
  busy?: boolean;
  steps?: readonly string[];
};

function TimelineDot({
  color,
  active,
  pulsing,
  failed,
}: {
  color: string;
  active: boolean;
  pulsing: boolean;
  failed: boolean;
}) {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (pulsing && active && !failed) {
      scale.value = withRepeat(
        withTiming(1.35, { duration: pulseTiming.duration, easing: pulseTiming.easing }),
        -1,
        true,
      );
      opacity.value = withRepeat(
        withTiming(0.45, { duration: pulseTiming.duration, easing: pulseTiming.easing }),
        -1,
        true,
      );
      return;
    }

    cancelAnimation(scale);
    cancelAnimation(opacity);
    scale.value = 1;
    opacity.value = 1;
  }, [active, failed, opacity, pulsing, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[
        styles.dot,
        {
          backgroundColor: color,
          borderColor: active ? color : 'transparent',
        },
        active && styles.dotActive,
        animatedStyle,
      ]}
    />
  );
}

export function ConnectionTimeline({
  activeStep,
  failed = false,
  busy = false,
  steps = CONNECTION_TIMELINE_STEPS,
}: ConnectionTimelineProps) {
  const tokens = useTokens();

  return (
    <View style={styles.rail}>
      {steps.map((label, index) => {
        const isComplete = activeStep >= 0 && index < activeStep;
        const isActive = activeStep >= 0 && index === activeStep;
        const dotColor = failed && isActive
          ? tokens.statusDisconnected
          : isComplete
            ? tokens.statusConnected
            : isActive
              ? tokens.accent
              : tokens.border;

        return (
          <Animated.View key={label} layout={Layout.duration(Motion.duration.normal)} style={styles.step}>
            <View style={styles.track}>
              {index > 0 ? (
                <View
                  style={[
                    styles.line,
                    {
                      backgroundColor: index <= activeStep ? tokens.accentMuted : tokens.border,
                    },
                  ]}
                />
              ) : null}
              <TimelineDot
                color={dotColor}
                active={isActive}
                pulsing={busy}
                failed={failed}
              />
            </View>
            <Text
              variant="caption"
              color={isActive ? (failed ? 'accentWarm' : 'accent') : isComplete ? 'secondary' : 'tertiary'}
              style={styles.label}>
              {label}
            </Text>
          </Animated.View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.one,
    paddingVertical: Spacing.one,
  },
  step: {
    flex: 1,
    alignItems: 'center',
    gap: Spacing.one,
  },
  track: {
    width: '100%',
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  line: {
    position: 'absolute',
    left: 0,
    right: '50%',
    height: 2,
    top: 7,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
  },
  dotActive: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  label: {
    textAlign: 'center',
  },
});