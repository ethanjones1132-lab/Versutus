import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { FontFamily, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { springSnappy } from '@/lib/motion/presets';
import { haptics } from '@/lib/haptics';

import { GlassSurface } from './GlassSurface';
import { Text } from './Text';

export type SegmentedControlOption<T extends string> = {
  key: T;
  label: string;
};

export type SegmentedControlProps<T extends string> = {
  options: SegmentedControlOption<T>[];
  selectedKey: T;
  onSelect: (key: T) => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * Equal-width segmented control with a sliding selection pill.
 *
 * A slim pill track, and a thumb lit like a raised surface — a soft lift with
 * the specular lip every floating surface carries — never a violet fill: the
 * chosen label reads by weight and brightness. The thumb travels the track's
 * inner width, so the last segment's thumb stays inside the track.
 */
export function SegmentedControl<T extends string>({
  options,
  selectedKey,
  onSelect,
  style,
}: SegmentedControlProps<T>) {
  const tokens = useTokens();
  const [trackWidth, setTrackWidth] = useState(0);
  // Where the thumb is, in pixels from the track's left padding. It is a shared
  // value rather than a derived style because the first position must be set
  // without a spring: see handleLayout.
  const offset = useSharedValue(0);
  const measured = useRef(false);

  const selectedIndex = Math.max(
    options.findIndex((option) => option.key === selectedKey),
    0,
  );
  // The thumb lives inside the track's padding, on both sides.
  const innerWidth = Math.max(0, trackWidth - Spacing.half * 2);
  const segmentWidth = innerWidth > 0 ? innerWidth / options.length : 0;

  /**
   * The first measurement says where the thumb already is, not where it should
   * fly in from. Animating from the first segment made every visit to Tools
   * show "Shell" selected for a quarter of a second before the pill slid over
   * to "Gateway RPC" — the reported wrong-pill defect.
   */
  const handleLayout = (width: number) => {
    setTrackWidth(width);
    const inner = Math.max(0, width - Spacing.half * 2);
    if (inner <= 0) return;
    const target = selectedIndex * (inner / options.length);
    offset.value = measured.current ? withSpring(target, springSnappy) : target;
    measured.current = true;
  };

  useEffect(() => {
    if (!measured.current || segmentWidth <= 0) return;
    offset.value = withSpring(selectedIndex * segmentWidth, springSnappy);
  }, [offset, segmentWidth, selectedIndex]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value }],
    width: segmentWidth,
  }));

  return (
    <GlassSurface variant="inset" radius={Radius.full} padding={0} style={[styles.track, style]}>
      <View
        style={styles.inner}
        onLayout={(event) => handleLayout(event.nativeEvent.layout.width)}>
        {segmentWidth > 0 ? (
          <Animated.View
            testID="segmented-indicator"
            style={[
              styles.indicator,
              { backgroundColor: tokens.rowSelected, borderTopColor: tokens.specular },
              indicatorStyle,
            ]}
          />
        ) : null}
        {options.map((option) => {
          const selected = option.key === selectedKey;
          return (
            <Pressable
              key={option.key}
              testID={`segment-${option.key}`}
              onPress={async () => {
                if (selected) return;
                await haptics.selection();
                onSelect(option.key);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={option.label}
              style={styles.segment}>
              <Text
                variant="caption"
                color={selected ? 'primary' : 'tertiary'}
                numberOfLines={1}
                style={selected ? styles.selectedLabel : null}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  track: {
    alignSelf: 'stretch',
  },
  inner: {
    flexDirection: 'row',
    position: 'relative',
    padding: Spacing.half,
  },
  indicator: {
    position: 'absolute',
    top: Spacing.half,
    bottom: Spacing.half,
    left: Spacing.half,
    borderRadius: Radius.full,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingVertical: Spacing.two,
  },
  selectedLabel: {
    fontFamily: FontFamily.sansSemiBold,
  },
});
