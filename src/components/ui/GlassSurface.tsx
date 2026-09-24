import { StyleSheet, View } from 'react-native';

import { Radius } from '@/constants/tokens';

import { glassVariantStyles } from './glass-variants';
import type { GlassSurfaceProps } from './types';

// Re-exported for any consumers that imported the map from the base module.
export { glassVariantStyles } from './glass-variants';

/**
 * Shared flat-surface implementation (Android + default): elevated panel +
 * hairline from the variant map, no blur primitive. Web and iOS can layer a
 * real glass material (backdrop blur / liquid glass) behind the `glass` opt-in;
 * Android has no blur here, so the prop is a no-op and stays flat either way.
 */
export function GlassSurface({
  children,
  style,
  variant = 'surface',
  radius = Radius.lg,
  padding = 0,
}: GlassSurfaceProps) {
  const variantStyle = glassVariantStyles[variant];

  return (
    <View
      style={[
        styles.surface,
        {
          backgroundColor: variantStyle.backgroundColor,
          borderColor: variantStyle.borderColor,
          borderRadius: radius,
          padding: padding > 0 ? padding : undefined,
        },
        style,
      ]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  surface: {
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
});
