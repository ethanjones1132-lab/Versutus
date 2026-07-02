import { StyleSheet, Text as RNText } from 'react-native';

import { FontFamily, Typography } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import type { TextProps } from './types';

const colorKey = {
  primary: 'textPrimary',
  secondary: 'textSecondary',
  tertiary: 'textTertiary',
  accent: 'accent',
  accentWarm: 'accentWarm',
  inverse: 'textInverse',
} as const;

const variantStyle = {
  display: { ...Typography.display, fontFamily: FontFamily.sansSemiBold },
  title: { ...Typography.title, fontFamily: FontFamily.sansSemiBold },
  headline: { ...Typography.headline, fontFamily: FontFamily.sansSemiBold },
  body: { ...Typography.body, fontFamily: FontFamily.sans },
  caption: { ...Typography.caption, fontFamily: FontFamily.sans },
  mono: { ...Typography.mono, fontFamily: FontFamily.mono },
  link: { ...Typography.body, fontFamily: FontFamily.sansSemiBold },
} as const;

export function Text({
  children,
  variant = 'body',
  color = 'primary',
  style,
  numberOfLines,
}: TextProps) {
  const tokens = useTokens();
  const tokenKey = colorKey[color];

  return (
    <RNText
      numberOfLines={numberOfLines}
      style={[
        variantStyle[variant],
        { color: tokens[tokenKey] },
        variant === 'link' && styles.link,
        style,
      ]}>
      {children}
    </RNText>
  );
}

const styles = StyleSheet.create({
  link: {
    textDecorationLine: 'underline',
  },
});