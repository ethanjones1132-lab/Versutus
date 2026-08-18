import { StyleSheet, View, type ViewStyle } from 'react-native';

import { Radius } from '@/constants/tokens';

import { glassVariantStyles } from './glass-variants';
import type { GlassSurfaceProps } from './types';

const webGlass = {
  backdropFilter: 'blur(28px) saturate(145%)',
  boxShadow: 'inset 0 1px 0 rgba(255, 236, 190, 0.08), 0 18px 48px rgba(0, 0, 0, 0.52)',
} as ViewStyle;

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
        webGlass,
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
