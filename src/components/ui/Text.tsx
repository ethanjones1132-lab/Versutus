import { StyleSheet, Text as RNText } from 'react-native';

import { FontFamily, Typography } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import type { TextProps, TextVariant } from './types';

const colorKey = {
  primary: 'textPrimary',
  secondary: 'textSecondary',
  tertiary: 'textTertiary',
  accent: 'accent',
  accentWarm: 'accentWarm',
  inverse: 'textInverse',
  statusConnected: 'statusConnected',
  statusConnecting: 'statusConnecting',
  statusDisconnected: 'statusDisconnected',
  statusPairing: 'statusPairing',
} as const;

const variantStyle = {
  display: { ...Typography.display, fontFamily: FontFamily.sansSemiBold },
  title: { ...Typography.title, fontFamily: FontFamily.sansSemiBold },
  headline: { ...Typography.headline, fontFamily: FontFamily.sansSemiBold },
  body: { ...Typography.body, fontFamily: FontFamily.sans },
  caption: { ...Typography.caption, fontFamily: FontFamily.sans },
  micro: { ...Typography.micro, fontFamily: FontFamily.sans },
  mono: { ...Typography.mono, fontFamily: FontFamily.mono },
  link: { ...Typography.body, fontFamily: FontFamily.sansSemiBold },
} as const;

/**
 * Per-variant caps on the OS font-size setting. Body and title text stays
 * uncapped so large-text users get the size they asked for; the small chrome
 * variants are capped because past ~1.4x they stop fitting their containers and
 * wrap mid-word or overlap neighbouring controls.
 */
const variantFontScaleCap: Partial<Record<TextVariant, number>> = {
  caption: 1.4,
  micro: 1.3,
  mono: 1.4,
};

export function Text({
  children,
  variant = 'body',
  color = 'primary',
  style,
  numberOfLines,
  maxFontSizeMultiplier,
  adjustsFontSizeToFit,
  selectable,
}: TextProps) {
  const tokens = useTokens();
  const tokenKey = colorKey[color];

  return (
    <RNText
      numberOfLines={numberOfLines}
      selectable={selectable}
      adjustsFontSizeToFit={adjustsFontSizeToFit}
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? variantFontScaleCap[variant]}
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