import { Host, Surface } from '@expo/ui/jetpack-compose';
import { StyleSheet, View } from 'react-native';

import { Radius } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import type { GlassSurfaceProps, GlassVariant } from './types';

type VariantConfig = {
  tonalElevation: number;
  shadowElevation: number;
  backgroundKey: 'backgroundElevated' | 'backgroundInset' | 'glass';
  defaultRadius: number;
};

const VARIANTS: Record<GlassVariant, VariantConfig> = {
  hero: {
    tonalElevation: 3,
    shadowElevation: 6,
    backgroundKey: 'backgroundElevated',
    defaultRadius: Radius.xl,
  },
  surface: {
    tonalElevation: 2,
    shadowElevation: 4,
    backgroundKey: 'backgroundElevated',
    defaultRadius: Radius.lg,
  },
  inset: {
    tonalElevation: 1,
    shadowElevation: 0,
    backgroundKey: 'backgroundInset',
    defaultRadius: Radius.md,
  },
  chip: {
    tonalElevation: 1,
    shadowElevation: 2,
    backgroundKey: 'backgroundElevated',
    defaultRadius: Radius.full,
  },
};

export function GlassSurface({
  children,
  style,
  variant = 'surface',
  radius,
  padding = 0,
}: GlassSurfaceProps) {
  const tokens = useTokens();
  const config = VARIANTS[variant];
  const resolvedRadius = radius ?? config.defaultRadius;
  const surfaceColor = tokens[config.backgroundKey];

  return (
    <View style={[styles.wrapper, { borderRadius: resolvedRadius, backgroundColor: surfaceColor }, style]}>
      <Host matchContents={{ horizontal: true, vertical: true }} style={StyleSheet.absoluteFill}>
        <Surface
          color={surfaceColor}
          contentColor={tokens.textPrimary}
          tonalElevation={config.tonalElevation}
          shadowElevation={config.shadowElevation}
          border={{ width: StyleSheet.hairlineWidth, color: tokens.glassBorder }}
        />
      </Host>
      <View style={padding > 0 ? { padding } : styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    overflow: 'hidden',
  },
  content: {
    padding: 0,
  },
});