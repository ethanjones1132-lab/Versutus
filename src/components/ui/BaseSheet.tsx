import * as Haptics from 'expo-haptics';
import { ReactNode, useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Motion, Radius } from '@/constants/tokens';
import { SHEET_MARGIN, sheetMaxHeight, sheetMaxWidth } from '@/lib/motion/sheet-height';
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
}: BaseSheetProps) {
  const tokens = useTokens();
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  // A sheet with no ceiling grows to its children. Anchored to the bottom,
  // that overflow leaves the screen upward and takes the header with it —
  // which is how ~40 sessions made "New session" unreachable. Bounding it here
  // is also what gives an inner FlatList a height to scroll within.
  const maxHeight = sheetMaxHeight({
    windowHeight,
    insetTop: insets.top,
    insetBottom: insets.bottom,
    position,
  });
  const maxWidth = sheetMaxWidth({ windowWidth });
  const hiddenOffset = position === 'bottom' ? 400 : -400;
  const translateY = useSharedValue(hiddenOffset);
  const [mounted, setMounted] = useState(visible);
  const [prevVisible, setPrevVisible] = useState(visible);
  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (visible) setMounted(true);
  }

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
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.overlay, isBottom ? styles.overlayBottom : styles.overlayTop]}>
        <Pressable style={styles.backdrop} onPress={handleBackdrop} accessibilityLabel="Dismiss sheet" />
        <Animated.View
          style={[
            isBottom ? styles.bottom : styles.top,
            {
              maxHeight,
              width: maxWidth,
              alignSelf: 'center',
              // Clear the system bars on the anchored edge; the opposite edge
              // is already handled by maxHeight.
              marginBottom: (isBottom ? SHEET_MARGIN.bottom.inner : 0) + (isBottom ? insets.bottom : 0),
              marginTop: (isBottom ? 0 : SHEET_MARGIN.top.inner) + (isBottom ? 0 : insets.top),
            },
            animatedStyle,
          ]}>
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
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
  },
  overlayBottom: {
    justifyContent: 'flex-end',
  },
  overlayTop: {
    justifyContent: 'flex-start',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  // marginBottom / marginTop are applied inline so they can carry the safe-area
  // inset; these remain for anything reading the base style.
  bottom: {},
  top: {},
  sheetSurface: {
    borderRadius: Radius.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
    overflow: 'hidden',
    // Never taller than the sheet: the header stays put and the content area
    // below it is what gives way.
    flexShrink: 1,
  },
  header: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 4,
  },
  eyebrow: {
    textTransform: 'uppercase',
  },
  title: {
    flexShrink: 0,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  content: {
    // Shrinks before the header does, so a long list scrolls inside the sheet
    // rather than pushing the title off the top of the screen.
    flexShrink: 1,
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
});
