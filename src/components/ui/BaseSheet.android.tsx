import * as Haptics from 'expo-haptics';
import { ReactNode, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { GlassSurface } from './GlassSurface';
import { PressableScale } from './PressableScale';
import { Text } from './Text';
import { Motion, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

interface BaseSheetProps {
  visible: boolean;
  title?: string;
  eyebrow?: string;
  onClose?: () => void;
  closeLabel?: string;
  children: ReactNode;
  position?: 'top' | 'bottom';
  zIndex?: number;
}

export function BaseSheet({
  visible,
  title,
  eyebrow = 'ACTION',
  onClose,
  closeLabel,
  children,
  position = 'bottom',
  zIndex = 30,
}: BaseSheetProps) {
  const tokens = useTokens();
  const hiddenOffset = position === 'bottom' ? 400 : -400;
  const translateY = useSharedValue(hiddenOffset);
  const backdropOpacity = useSharedValue(0);
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  useEffect(() => {
    translateY.value = withTiming(
      visible ? 0 : hiddenOffset,
      {
        duration: Motion.duration.normal,
        easing: Easing.out(Easing.cubic),
      },
      (finished) => {
        if (finished && !visible) {
          runOnJS(setMounted)(false);
        }
      },
    );
    backdropOpacity.value = withTiming(visible ? 1 : 0, {
      duration: Motion.duration.normal,
      easing: Easing.out(Easing.cubic),
    });
  }, [backdropOpacity, hiddenOffset, translateY, visible]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  if (!mounted) return null;

  const isBottom = position === 'bottom';

  const handleBackdrop = () => {
    if (onClose) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onClose();
    }
  };

  return (
    <View style={[styles.overlay, { zIndex }]} pointerEvents="box-none">
      <Animated.View
        style={[styles.backdrop, { backgroundColor: tokens.background }, backdropStyle]}
        pointerEvents={visible ? 'auto' : 'none'}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleBackdrop} accessibilityRole="button" />
      </Animated.View>

      <Animated.View
        style={[styles.sheet, isBottom ? styles.bottom : styles.top, animatedStyle]}
        pointerEvents="box-none">
        <GlassSurface
          variant="hero"
          padding={0}
          style={[styles.sheetSurface, { borderColor: tokens.accentWarmMuted }]}>
          <View style={styles.header}>
            <Text variant="mono" color="accentWarm" style={styles.eyebrow}>
              {eyebrow}
            </Text>
            {onClose ? (
              <PressableScale
                onPress={async () => {
                  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  onClose();
                }}
                hitSlop={12}>
                <Text variant="caption" color="tertiary">
                  {closeLabel || 'Close'}
                </Text>
              </PressableScale>
            ) : null}
          </View>

          {title ? (
            <Text variant="title" style={styles.title}>
              {title}
            </Text>
          ) : null}

          <View style={styles.content}>{children}</View>
        </GlassSurface>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    opacity: 0.72,
  },
  sheet: {
    marginHorizontal: Spacing.four,
  },
  bottom: {
    marginBottom: Spacing.four,
  },
  top: {
    marginTop: Spacing.two,
    justifyContent: 'flex-start',
  },
  sheetSurface: {
    borderRadius: Radius.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.one,
  },
  eyebrow: {
    textTransform: 'uppercase',
  },
  title: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  content: {
    paddingHorizontal: Spacing.two,
    paddingBottom: Spacing.two,
  },
});