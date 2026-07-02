import { Host, OutlinedTextField, useNativeState } from '@expo/ui/jetpack-compose';
import { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Radius } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import type { TextFieldProps } from './types';

export function TextField({
  value,
  onChangeText,
  placeholder,
  validationState = 'default',
  secureTextEntry,
  multiline,
  editable = true,
  style,
}: TextFieldProps) {
  const tokens = useTokens();
  const textState = useNativeState(value);

  const indicatorColor = useMemo(() => {
    if (validationState === 'valid') return tokens.statusConnected;
    if (validationState === 'invalid') return tokens.accentWarm;
    return tokens.border;
  }, [tokens.accentWarm, tokens.border, tokens.statusConnected, validationState]);

  const focusedIndicatorColor = useMemo(() => {
    if (validationState === 'valid') return tokens.statusConnected;
    if (validationState === 'invalid') return tokens.accentWarm;
    return tokens.accentWarm;
  }, [tokens.accentWarm, tokens.statusConnected, validationState]);

  useEffect(() => {
    if (textState.get() !== value) {
      textState.set(value);
    }
  }, [textState, value]);

  return (
    <View
      style={[
        styles.host,
        validationState === 'invalid' && { borderColor: tokens.accentWarmMuted, borderWidth: 1 },
        validationState === 'valid' && { borderColor: tokens.accentMuted, borderWidth: 1 },
        style,
      ]}>
      <Host matchContents={{ horizontal: true, vertical: true }}>
        <OutlinedTextField
          value={textState}
          onValueChange={onChangeText}
          enabled={editable}
          visualTransformation={secureTextEntry ? 'password' : 'none'}
          singleLine={!multiline}
          colors={{
            focusedTextColor: tokens.textPrimary,
            unfocusedTextColor: tokens.textPrimary,
            focusedContainerColor: tokens.glass,
            unfocusedContainerColor: tokens.backgroundInset,
            focusedIndicatorColor,
            unfocusedIndicatorColor: indicatorColor,
            focusedPlaceholderColor: tokens.textTertiary,
            unfocusedPlaceholderColor: tokens.textTertiary,
            cursorColor: tokens.accentWarm,
          }}>
          {placeholder ? (
            <OutlinedTextField.Placeholder>{placeholder}</OutlinedTextField.Placeholder>
          ) : null}
        </OutlinedTextField>
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    alignSelf: 'stretch',
    borderRadius: Radius.md,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
});
