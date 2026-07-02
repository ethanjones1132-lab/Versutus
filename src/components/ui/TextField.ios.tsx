import { Host, TextField as SwiftTextField, useNativeState } from '@expo/ui/swift-ui';
import { background, cornerRadius, frame, padding } from '@expo/ui/swift-ui/modifiers';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { Palette, Radius } from '@/constants/tokens';

import type { TextFieldProps } from './types';

export function TextField({
  value,
  onChangeText,
  placeholder,
  multiline,
  editable = true,
  autoCapitalize = 'none',
  style,
}: TextFieldProps) {
  const textState = useNativeState(value);

  useEffect(() => {
    if (textState.get() !== value) {
      textState.set(value);
    }
  }, [textState, value]);

  return (
    <View style={[styles.host, style]}>
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
  },
});
