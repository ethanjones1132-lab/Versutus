import { Button as SwiftButton, Host } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, disabled, tint } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';

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

  const swiftStyle =
    variant === 'primary'
      ? 'glassProminent'
      : variant === 'secondary'
        ? 'glass'
        : variant === 'ghost'
          ? 'plain'
          : 'bordered';

  const accentTint = variant === 'destructive' ? tokens.statusDisconnected : tokens.accentWarm;

  return (
    <View style={[styles.host, style]}>
      <Host matchContents={{ horizontal: true, vertical: true }}>
        <SwiftButton
          label={label}
          onPress={onPress}
          role={variant === 'destructive' ? 'destructive' : 'default'}
          modifiers={[
            buttonStyle(swiftStyle),
            controlSize('large'),
            tint(accentTint),
            disabled(!!isDisabled),
          ]}
        />
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    alignSelf: 'stretch',
  },
});
