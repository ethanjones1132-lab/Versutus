import { StyleSheet, TextInput } from 'react-native';

import { FontFamily, Radius } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import type { Ref } from 'react';
import type { StyleProp, TextStyle } from 'react-native';

import type { TextFieldProps } from './types';

type TextFieldSharedProps = Omit<TextFieldProps, 'style'> & {
  style?: StyleProp<TextStyle>;
  /**
   * The input's own handle, for a host that has to drive the field (a Bot Chat
   * link opens the composer and puts the cursor in it). Optional: a field with
   * no handle renders exactly as it did.
   */
  inputRef?: Ref<TextFieldHandle>;
};

/**
 * The handle this field hands back: on this platform the react-native input
 * itself. Exported as a name so a host can hold it without importing
 * react-native's `TextInput` — the retirement guard keeps that name inside the
 * kit (see `__tests__/raw-text-input-retirement-test.ts`).
 */
export type TextFieldHandle = TextInput;

export function TextField({
  value,
  onChangeText,
  placeholder,
  validationState = 'default',
  secureTextEntry,
  multiline,
  autoCapitalize = 'none',
  autoCorrect = false,
  editable = true,
  onSubmitEditing,
  returnKeyType,
  onKeyPress,
  onFocus,
  onBlur,
  accessibilityLabel,
  style,
  inputRef,
}: TextFieldSharedProps) {
  const tokens = useTokens();
  const borderColor =
    validationState === 'valid'
      ? tokens.statusConnected
      : validationState === 'invalid'
        ? tokens.statusDisconnected
        : tokens.glassBorder;
  const borderWidth = validationState === 'default' ? StyleSheet.hairlineWidth : 1.5;

  return (
    <TextInput
      ref={inputRef}
      style={[
        styles.input,
        {
          color: tokens.textPrimary,
          backgroundColor: tokens.glass,
          borderColor,
          borderWidth,
        },
        multiline && styles.multiline,
        style,
      ]}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={tokens.textTertiary}
      secureTextEntry={secureTextEntry}
      multiline={multiline}
      autoCapitalize={autoCapitalize}
      autoCorrect={autoCorrect}
      editable={editable}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyPress={onKeyPress}
      onSubmitEditing={onSubmitEditing}
      returnKeyType={returnKeyType}
      accessibilityState={{ disabled: !editable }}
      accessibilityLabel={
        accessibilityLabel ??
        (validationState === 'invalid'
          ? 'Invalid input'
          : validationState === 'valid'
            ? 'Valid input'
            : undefined)
      }
    />
  );
}

const styles = StyleSheet.create({
  input: {
    fontFamily: FontFamily.sans,
    fontSize: 16,
    lineHeight: 22,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: Radius.md,
  },
  multiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
});
