import * as Haptics from 'expo-haptics';
import { ReactNode, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
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
  }, [hiddenOffset, translateY, visible]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
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
    <View style={[styles.overlay, { zIndex, pointerEvents: 'box-none' }]}>
      <PressableScale style={styles.backdrop} onPress={handleBackdrop} />
      <Animated.View
        style={[
          styles.sheet,
          isBottom ? styles.bottom : styles.top,
          animatedStyle,
        ]}
      >
        <GlassSurface
          variant="hero"
          padding={0}
          style={[
            styles.sheetSurface,
            { borderColor: tokens.accentWarmMuted },
          ]}
        >
          <View style={styles.header}>
            <Text variant="mono" color="accentWarm" style={styles.eyebrow}>
              {eyebrow}
            </Text>
            {onClose && (
              <PressableScale onPress={async () => {
                await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onClose();
              }} hitSlop={12}>
                <Text variant="caption" color="tertiary">
                  {closeLabel || 'Close'}
                </Text>
              </PressableScale>
            )}
          </View>

          {title && (
            <Text variant="title" style={styles.title}>
              {title}
            </Text>
          )}

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
    backgroundColor: 'rgba(0,0,0,0.6)',
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