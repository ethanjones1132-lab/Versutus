import { Button as ComposeButton, Host, Text } from '@expo/ui/jetpack-compose';
import { StyleSheet, View } from 'react-native';

import { FontFamily, Radius } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import type { ButtonProps } from './types';

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled: isDisabled,
  style,
}: ButtonProps) {
  const tokens = useTokens();

  const colors =
    variant === 'primary'
      ? {
          containerColor: tokens.accentWarm,
          contentColor: tokens.textInverse,
          disabledContainerColor: tokens.accentMuted,
          disabledContentColor: tokens.textTertiary,
        }
      : variant === 'destructive'
        ? {
            containerColor: tokens.statusDisconnected,
            contentColor: tokens.textPrimary,
            disabledContainerColor: tokens.accentWarmMuted,
            disabledContentColor: tokens.textTertiary,
          }
        : variant === 'secondary'
          ? {
              containerColor: tokens.glass,
              contentColor: tokens.textPrimary,
              disabledContainerColor: tokens.backgroundInset,
              disabledContentColor: tokens.textTertiary,
            }
          : {
              containerColor: 'transparent',
              contentColor: tokens.accent,
              disabledContainerColor: 'transparent',
              disabledContentColor: tokens.textTertiary,
            };

  const bordered = variant === 'primary' || variant === 'secondary' || variant === 'ghost';

  return (
    <View
      style={[
        styles.host,
        bordered && {
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: variant === 'primary' ? tokens.accentWarm : variant === 'ghost' ? 'transparent' : tokens.glassBorder,
        },
        style,
      ]}>
      <Host matchContents={{ horizontal: true, vertical: true }}>
        <ComposeButton
          onClick={onPress}
          enabled={!isDisabled}
          colors={colors}
          contentPadding={{ start: 22, end: 22, top: 13, bottom: 13 }}>
          <Text
            color={String(colors.contentColor)}
            style={{
              fontSize: 15,
              fontWeight: '600',
              fontFamily: FontFamily.sansSemiBold,
              letterSpacing: 0.2,
            }}>
            {label}
          </Text>
        </ComposeButton>
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    alignSelf: 'stretch',
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
});
