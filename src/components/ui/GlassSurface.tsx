import { StyleSheet, View } from 'react-native';

import { Palette, Radius } from '@/constants/tokens';

import type { GlassSurfaceProps, GlassVariant } from './types';

/**
 * Variant → surface treatment. Shared by all platforms; platform files may
 * layer native effects (blur/liquid glass) on top of the same mapping.
 */
export const glassVariantStyles: Record<
  GlassVariant,
  { backgroundColor: string; borderColor: string }
> = {
  hero: { backgroundColor: Palette.glassHero, borderColor: Palette.glassHeroBorder },
  surface: { backgroundColor: Palette.glass, borderColor: Palette.glassBorder },
  inset: { backgroundColor: Palette.backgroundInset, borderColor: Palette.borderSubtle },
  chip: { backgroundColor: Palette.accentMuted, borderColor: Palette.accentWarmMuted },
};

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
