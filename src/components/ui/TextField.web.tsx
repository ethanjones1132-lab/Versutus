import { StyleSheet, TextInput } from 'react-native';

import { FontFamily, Radius } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import type { StyleProp, TextStyle } from 'react-native';

import type { TextFieldProps } from './types';

type TextFieldWebProps = Omit<TextFieldProps, 'style'> & {
  style?: StyleProp<TextStyle>;
};

export function TextField({
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  multiline,
  autoCapitalize = 'none',
  autoCorrect = false,
  editable = true,
  onSubmitEditing,
  returnKeyType,
  style,
}: TextFieldWebProps) {
  const tokens = useTokens();

  return (
    <TextInput
      style={[
        styles.input,
        {
          color: tokens.textPrimary,
          backgroundColor: tokens.glass,
          borderColor: tokens.glassBorder,
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
    borderWidth: StyleSheet.hairlineWidth,
  },
  multiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
});
