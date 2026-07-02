import { Platform, StyleSheet, Text, type TextProps } from 'react-native';

import { FontFamily, Palette, Typography } from '@/constants/tokens';
import { ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ThemedTextProps = TextProps & {
  type?: 'default' | 'title' | 'small' | 'smallBold' | 'subtitle' | 'link' | 'linkPrimary' | 'code';
  themeColor?: ThemeColor;
};

export function ThemedText({ style, type = 'default', themeColor, ...rest }: ThemedTextProps) {
  const theme = useTheme();

  return (
    <Text
      style={[
        { color: theme[themeColor ?? 'text'] },
        type === 'default' && styles.default,
        type === 'title' && styles.title,
        type === 'small' && styles.small,
        type === 'smallBold' && styles.smallBold,
        type === 'subtitle' && styles.subtitle,
        type === 'link' && styles.link,
        type === 'linkPrimary' && styles.linkPrimary,
        type === 'code' && styles.code,
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  small: {
    ...Typography.caption,
    fontFamily: FontFamily.sans,
  },
  smallBold: {
    ...Typography.caption,
    fontFamily: FontFamily.sansBold,
  },
  default: {
    ...Typography.body,
    fontFamily: FontFamily.sans,
  },
  title: {
    ...Typography.display,
    fontSize: 48,
    lineHeight: 52,
    fontFamily: FontFamily.sansSemiBold,
  },
  subtitle: {
    ...Typography.title,
    fontFamily: FontFamily.sansSemiBold,
  },
  link: {
    lineHeight: 30,
    fontSize: 14,
    fontFamily: FontFamily.sans,
  },
  linkPrimary: {
    lineHeight: 30,
    fontSize: 14,
    color: Palette.accent,
    fontFamily: FontFamily.sansSemiBold,
  },
  code: {
    ...Typography.mono,
    fontFamily: FontFamily.mono,
    fontWeight: Platform.select({ android: '700' as const }) ?? '500',
  },
});
