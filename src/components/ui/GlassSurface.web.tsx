import { StyleSheet, View, type ViewStyle } from 'react-native';

import { Radius } from '@/constants/tokens';

import { glassVariantStyles } from './glass-variants';
import type { GlassSurfaceProps } from './types';

// Backdrop blur + lift, applied only when a consumer opts into glass —
// borderless flat panels carry the default (visual-direction lock).
const webGlass = {
  backdropFilter: 'blur(28px) saturate(145%)',
  boxShadow: 'inset 0 1px 0 rgba(245, 247, 250, 0.06), 0 18px 48px rgba(0, 0, 0, 0.52)',
} as ViewStyle;

export function GlassSurface({
  children,
  style,
  glass = false,
  variant = 'surface',
  radius = Radius.lg,
  padding = 0,
}: GlassSurfaceProps) {
  const variantStyle = glassVariantStyles[variant];

  return (
    <View
      style={[
        styles.surface,
        glass ? webGlass : null,
        {
          backgroundColor: variantStyle.backgroundColor,
          borderColor: variantStyle.borderColor,
          borderWidth: variantStyle.borderWidth,
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
    overflow: 'hidden',
  },
});
