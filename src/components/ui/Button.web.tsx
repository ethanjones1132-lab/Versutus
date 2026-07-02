import { StyleSheet } from 'react-native';

import { FontFamily, Radius } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import { PressableScale } from './PressableScale';
import { Text } from './Text';
import type { ButtonProps } from './types';

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled: isDisabled,
  style,
}: ButtonProps) {
  const tokens = useTokens();

  const variantStyles =
    variant === 'primary'
      ? { backgroundColor: tokens.accentWarm, color: 'inverse' as const, borderColor: tokens.accentWarm }
      : variant === 'destructive'
        ? { backgroundColor: tokens.statusDisconnected, color: 'inverse' as const, borderColor: tokens.statusDisconnected }
        : variant === 'secondary'
          ? { backgroundColor: tokens.glass, color: 'primary' as const, borderColor: tokens.glassBorder }
          : { backgroundColor: 'transparent', color: 'accentWarm' as const, borderColor: 'transparent' };

  return (
    <PressableScale
      onPress={onPress}
      disabled={isDisabled}
      style={[
        styles.button,
        {
          backgroundColor: variantStyles.backgroundColor,
          borderColor: variantStyles.borderColor,
          opacity: isDisabled ? 0.5 : 1,
        },
        variant === 'primary' && styles.primary,
        style,
      ]}>
      <Text variant="body" color={variantStyles.color} style={styles.label}>
        {label}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    paddingHorizontal: 20,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  primary: {
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.28), 0 10px 24px rgba(214,183,106,0.18)',
  },
  label: {
    fontFamily: FontFamily.sansSemiBold,
  },
});
