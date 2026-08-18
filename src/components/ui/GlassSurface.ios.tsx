import { GlassView } from 'expo-glass-effect';
import { StyleSheet, View } from 'react-native';

import { Radius } from '@/constants/tokens';

import { glassVariantStyles } from './glass-variants';
import type { GlassSurfaceProps } from './types';

export function GlassSurface({
  children,
  style,
  interactive = false,
  variant = 'surface',
  radius = Radius.lg,
  padding = 0,
}: GlassSurfaceProps) {
  const variantStyle = glassVariantStyles[variant];

  return (
    <GlassView
      glassEffectStyle="regular"
      colorScheme="dark"
      isInteractive={interactive}
      tintColor={variantStyle.backgroundColor}
      style={[
        styles.surface,
        { borderRadius: radius, borderColor: variantStyle.borderColor },
        style,
      ]}>
      <View style={padding > 0 ? { padding } : undefined}>{children}</View>
    </GlassView>
  );
}

const styles = StyleSheet.create({
  surface: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
});
