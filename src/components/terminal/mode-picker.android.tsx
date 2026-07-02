import {
  Host,
  SegmentedButton,
  SingleChoiceSegmentedButtonRow,
} from '@expo/ui/jetpack-compose';
import * as Haptics from 'expo-haptics';
import { StyleSheet } from 'react-native';

import { TERMINAL_MODES, type TerminalMode } from '@/components/terminal/terminal-modes';
import { useTokens } from '@/hooks/use-tokens';

export type { TerminalMode } from '@/components/terminal/terminal-modes';

export function TerminalModePicker({
  mode,
  onModeChange,
}: {
  mode: TerminalMode;
  onModeChange: (mode: TerminalMode) => void;
}) {
  const tokens = useTokens();

  return (
    <Host matchContents style={styles.host}>
      <SingleChoiceSegmentedButtonRow>
        {TERMINAL_MODES.map((item) => (
          <SegmentedButton
            key={item.id}
            selected={mode === item.id}
            onClick={async () => {
              if (mode !== item.id) {
                await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onModeChange(item.id);
              }
            }}
            colors={{
              activeContainerColor: tokens.accent,
              activeContentColor: tokens.textInverse,
              inactiveContainerColor: tokens.backgroundElevated,
              inactiveContentColor: tokens.textSecondary,
            }}>
            <SegmentedButton.Label>{item.label}</SegmentedButton.Label>
          </SegmentedButton>
        ))}
      </SingleChoiceSegmentedButtonRow>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    alignSelf: 'stretch',
  },
});