import { GlassView } from 'expo-glass-effect';
import { StyleSheet, View } from 'react-native';

import { Radius } from '@/constants/tokens';

import { glassVariantStyles } from './glass-variants';
import type { GlassSurfaceProps } from './types';

export function GlassSurface({
  children,
  style,
  interactive = false,
  glass = false,
  variant = 'surface',
  radius = Radius.lg,
  padding = 0,
}: GlassSurfaceProps) {
  const variantStyle = glassVariantStyles[variant];

  // Flat elevated panel + hairline is the default material; liquid glass is
  // an explicit opt-in (sheets/modals), never what a card lands on.
  if (!glass) {
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
