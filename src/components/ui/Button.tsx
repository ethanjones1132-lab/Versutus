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
  accessibilityHint,
  expanded,
  busy,
  selected,
}: ButtonProps) {
  const tokens = useTokens();

  // Primary is the violet jewel: the deep end of the brand gradient under a
  // white label (4.7:1), lit along its top lip and casting a violet glow. The
  // lighter brand accent stays for links, focus and glyphs, where it is light
  // rather than a fill.
  const variantStyles =
    variant === 'primary'
      ? { backgroundColor: tokens.accentDeep, color: 'primary' as const, borderColor: tokens.accent }
      : variant === 'destructive'
        ? { backgroundColor: tokens.statusDisconnected, color: 'inverse' as const, borderColor: tokens.statusDisconnected }
        : variant === 'secondary'
          ? { backgroundColor: tokens.backgroundRaised, color: 'primary' as const, borderColor: tokens.specular }
          : { backgroundColor: 'transparent', color: 'accent' as const, borderColor: 'transparent' };

  return (
    <PressableScale
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, ...(expanded !== undefined ? { expanded } : null), ...(busy !== undefined ? { busy } : null), ...(selected !== undefined ? { selected } : null) }}
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
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
        variant={size === 'sm' ? 'caption' : 'callout'}
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
    minHeight: 52,
    paddingVertical: Spacing.three - 2,
    paddingHorizontal: Spacing.four,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  buttonSm: {
    minHeight: 36,
    paddingVertical: Spacing.two - 1,
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.md,
  },
  primary: {
    // Violet brand lift on the near-black stage — never the old champagne gold.
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.22), 0 10px 28px rgba(139,124,255,0.28)',
  },
  label: {
    fontFamily: FontFamily.sansSemiBold,
  },
});
