import { StyleSheet, View } from 'react-native';

import { Radius } from '@/constants/tokens';

import { glassVariantStyles } from './glass-variants';
import type { GlassSurfaceProps } from './types';

// Re-exported for any consumers that imported the map from the base module.
export { glassVariantStyles } from './glass-variants';

/**
 * Shared frosted-surface implementation (Android + default). Web adds a real
 * backdrop blur (GlassSurface.web); iOS adds liquid glass (GlassSurface.ios).
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
