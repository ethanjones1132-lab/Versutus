import { Host, SecureField, TextField as SwiftTextField, useNativeState, type TextFieldRef } from '@expo/ui/swift-ui';
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
import type { Ref } from 'react';
import type { TextFieldProps } from './types';

// Platform contract, kept honest instead of silent: the SwiftUI-backed field
// forwards autoCapitalize, autoCorrect, secureTextEntry (via SecureField),
// returnKeyType (submitLabel), onSubmitEditing (onSubmit) and editable
// (disabled) onto the native field. The one shared prop with no SwiftUI
// counterpart is onKeyPress — hardware-key events don't cross this bridge —
// so surfaces owning key behaviors keep an explicit on-screen affordance
// (a send button, e.g.) so the action stays reachable on iOS.

/**
 * The handle this field hands back: on this platform the SwiftUI field's own
 * (`focus()`, `blur()`, `setText()` …). The same name the base field exports,
 * so a host asked for a cursor does not care which field it holds.
 */
export type TextFieldHandle = TextFieldRef;

type TextFieldIosProps = TextFieldProps & {
  /**
   * The field's own handle, for a host that has to drive it (a Bot Chat link
   * opens the composer and puts the cursor in it). Optional: a field with no
   * handle renders exactly as it did.
   */
  inputRef?: Ref<TextFieldHandle>;
};

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
  inputRef,
}: TextFieldIosProps) {
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
      accessibilityState={{ disabled: !editable }}
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
            ref={inputRef}
            text={textState}
            placeholder={placeholder}
            onTextChange={onChangeText}
            onFocusChange={handleFocusChange}
            modifiers={modifiers}
          />
        ) : (
          <SwiftTextField
            ref={inputRef}
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
