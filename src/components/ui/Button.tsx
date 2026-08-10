import { StyleSheet } from 'react-native';

import { FontFamily, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import { PressableScale } from './PressableScale';
import { Text } from './Text';
import type { ButtonProps } from './types';

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
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
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled }}
      accessibilityLabel={label}
      style={[
        styles.button,
        size === 'sm' && styles.buttonSm,
        {
          backgroundColor: variantStyles.backgroundColor,
          borderColor: variantStyles.borderColor,
          opacity: isDisabled ? 0.5 : 1,
        },
        variant === 'primary' && styles.primary,
        style,
      ]}>
      <Text
        variant={size === 'sm' ? 'caption' : 'body'}
        color={variantStyles.color}
        numberOfLines={1}
        // A button label must stay on one line inside its own box. Unbounded
        // scaling made labels wrap out of their container and collide with
        // adjacent controls.
        maxFontSizeMultiplier={1.3}
        style={styles.label}>
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
  buttonSm: {
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  primary: {
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.28), 0 10px 24px rgba(214,183,106,0.18)',
  },
  label: {
    fontFamily: FontFamily.sansSemiBold,
  },
});
