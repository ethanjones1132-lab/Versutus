import { Host, TextField as SwiftTextField, useNativeState } from '@expo/ui/swift-ui';
import { background, cornerRadius, frame, padding } from '@expo/ui/swift-ui/modifiers';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { Palette, Radius } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import type { TextFieldProps } from './types';

export function TextField({
  value,
  onChangeText,
  placeholder,
  validationState = 'default',
  multiline,
  editable = true,
  autoCapitalize = 'none',
  style,
}: TextFieldProps) {
  const tokens = useTokens();
  const textState = useNativeState(value);

  useEffect(() => {
    if (textState.get() !== value) {
      textState.set(value);
    }
  }, [textState, value]);

  const borderColor =
    validationState === 'valid'
      ? tokens.statusConnected
      : validationState === 'invalid'
        ? tokens.statusDisconnected
        : tokens.glassBorder;

  return (
    <View
      style={[
        styles.host,
        {
          borderColor,
          borderWidth: validationState === 'default' ? StyleSheet.hairlineWidth : 1.5,
        },
        style,
      ]}
      accessibilityLabel={
        validationState === 'invalid'
          ? 'Invalid input'
          : validationState === 'valid'
            ? 'Valid input'
            : undefined
      }>
      <Host matchContents={{ horizontal: true, vertical: true }}>
        <SwiftTextField
          text={textState}
          placeholder={placeholder}
          onTextChange={onChangeText}
          axis={multiline ? 'vertical' : 'horizontal'}
          modifiers={[
            padding({ all: 14 }),
            cornerRadius(Radius.md),
            background(Palette.glass),
            frame({ maxWidth: Infinity }),
          ]}
        />
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    alignSelf: 'stretch',
    opacity: 1,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
});
