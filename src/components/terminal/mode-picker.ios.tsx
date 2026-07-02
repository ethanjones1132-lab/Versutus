import { Host, Picker, Text as SwiftText } from '@expo/ui/swift-ui';
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';

import { TERMINAL_MODES, type TerminalMode } from '@/components/terminal/terminal-modes';

export type { TerminalMode } from '@/components/terminal/terminal-modes';

export function TerminalModePicker({
  mode,
  onModeChange,
}: {
  mode: TerminalMode;
  onModeChange: (mode: TerminalMode) => void;
}) {
  return (
    <Host matchContents style={styles.host}>
      <Picker
        selection={mode}
        onSelectionChange={(value) => onModeChange(value as TerminalMode)}
        modifiers={[pickerStyle('segmented')]}>
        {TERMINAL_MODES.map((item) => (
          <SwiftText key={item.id} modifiers={[tag(item.id)]}>
            {item.label}
          </SwiftText>
        ))}
      </Picker>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    alignSelf: 'stretch',
  },
});