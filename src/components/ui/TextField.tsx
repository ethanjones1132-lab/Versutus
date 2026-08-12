import { StyleSheet, TextInput } from 'react-native';

import { FontFamily, Radius } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import type { StyleProp, TextStyle } from 'react-native';

import type { TextFieldProps } from './types';

type TextFieldSharedProps = Omit<TextFieldProps, 'style'> & {
  style?: StyleProp<TextStyle>;
};

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
  style,
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
      onSubmitEditing={onSubmitEditing}
      returnKeyType={returnKeyType}
      accessibilityLabel={
        validationState === 'invalid'
          ? 'Invalid input'
          : validationState === 'valid'
            ? 'Valid input'
            : undefined
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
