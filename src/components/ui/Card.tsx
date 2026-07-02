import { StyleSheet, type ViewStyle } from 'react-native';

import { Spacing } from '@/constants/tokens';

import { GlassSurface } from './GlassSurface';
import type { CardProps } from './types';

export function Card({
  children,
  style,
  interactive = false,
  variant = 'surface',
  padding = Spacing.three,
}: CardProps) {
  const flatStyle = StyleSheet.flatten(style) as ViewStyle | undefined;
  const radius = typeof flatStyle?.borderRadius === 'number' ? flatStyle.borderRadius : undefined;

  return (
    <GlassSurface
      interactive={interactive}
      variant={variant}
      radius={radius}
      padding={padding}
      style={[styles.card, style]}>
      {children}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'stretch',
  },
});