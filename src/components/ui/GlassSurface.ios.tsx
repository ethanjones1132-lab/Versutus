import { GlassView } from 'expo-glass-effect';
import { StyleSheet, View } from 'react-native';

import { Palette, Radius } from '@/constants/tokens';

import type { GlassSurfaceProps } from './types';

export function GlassSurface({
  children,
  style,
  interactive = false,
  radius = Radius.lg,
  padding = 0,
}: GlassSurfaceProps) {
  return (
    <GlassView
      glassEffectStyle="regular"
      colorScheme="dark"
      isInteractive={interactive}
      tintColor={Palette.glass}
      style={[styles.surface, { borderRadius: radius }, style]}>
      <View style={padding > 0 ? { padding } : undefined}>{children}</View>
    </GlassView>
  );
}

const styles = StyleSheet.create({
  surface: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.glassBorder,
  },
});