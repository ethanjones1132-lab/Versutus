import { Host, SecureField, TextField as SwiftTextField, useNativeState } from '@expo/ui/swift-ui';
import {
  autocorrectionDisabled,
  background,
  cornerRadius,
  disabled,
  frame,
  onSubmit,
  padding,
  submitLabel,
  textInputAutocapitalization,
} from '@expo/ui/swift-ui/modifiers';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { Palette, Radius } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import {
  autocapitalizationFor,
  autocorrectionDisabledFor,
  submitLabelFor,
  usesSecureField,
} from './text-field-ios';
import type { TextFieldProps } from './types';

// Platform contract, kept honest instead of silent: the SwiftUI-backed field
// forwards autoCapitalize, autoCorrect, secureTextEntry (via SecureField),
// returnKeyType (submitLabel), onSubmitEditing (onSubmit) and editable
// (disabled) onto the native field. The one shared prop with no SwiftUI
// counterpart is onKeyPress — hardware-key events don't cross this bridge —
// so surfaces owning key behaviors keep an explicit on-screen affordance
// (a send button, e.g.) so the action stays reachable on iOS.
export function TextField({
  value,
  onChangeText,
  placeholder,
  validationState = 'default',
  secureTextEntry,
  multiline,
  editable = true,
  autoCapitalize = 'none',
  autoCorrect = false,
  onSubmitEditing,
  returnKeyType,
  onFocus,
  onBlur,
  accessibilityLabel,
  style,
}: TextFieldProps) {
  const tokens = useTokens();
  const textState = useNativeState(value);

  useEffect(() => {
    if (textState.get() !== value) {
      textState.set(value);
    }
  }, [textState, value]);

  const handleFocusChange = (focused: boolean) => {
    if (focused) {
      onFocus?.();
    } else {
      onBlur?.();
    }
  };

  const borderColor =
    validationState === 'valid'
      ? tokens.statusConnected
      : validationState === 'invalid'
        ? tokens.statusDisconnected
        : tokens.glassBorder;

  const modifiers = [
    padding({ all: 14 }),
    cornerRadius(Radius.md),
    background(Palette.glass),
    frame({ maxWidth: Infinity }),
    textInputAutocapitalization(autocapitalizationFor(autoCapitalize)),
    autocorrectionDisabled(autocorrectionDisabledFor(autoCorrect)),
    ...(returnKeyType ? [submitLabel(submitLabelFor(returnKeyType))] : []),
    ...(!editable ? [disabled(true)] : []),
    ...(onSubmitEditing ? [onSubmit(onSubmitEditing)] : []),
  ];

  const secure = usesSecureField(secureTextEntry);

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
        accessibilityLabel ??
        (validationState === 'invalid'
          ? 'Invalid input'
          : validationState === 'valid'
            ? 'Valid input'
            : undefined)
      }>
      <Host matchContents={{ horizontal: true, vertical: true }}>
        {secure ? (
          <SecureField
            text={textState}
            placeholder={placeholder}
            onTextChange={onChangeText}
            onFocusChange={handleFocusChange}
            modifiers={modifiers}
          />
        ) : (
          <SwiftTextField
            text={textState}
            placeholder={placeholder}
            onTextChange={onChangeText}
            onFocusChange={handleFocusChange}
            axis={multiline ? 'vertical' : 'horizontal'}
            modifiers={modifiers}
          />
        )}
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
