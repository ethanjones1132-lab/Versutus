import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, View } from 'react-native';

import { TERMINAL_MODES, type TerminalMode } from '@/components/terminal/terminal-modes';
import { Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
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
    <View style={styles.fallback}>
      {TERMINAL_MODES.map((item) => {
        const selected = mode === item.id;
        return (
          <Pressable
            key={item.id}
            onPress={async () => {
              await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onModeChange(item.id);
            }}
            style={[
              styles.segment,
              {
                backgroundColor: selected ? tokens.accent : tokens.backgroundElevated,
                borderColor: selected ? tokens.accent : tokens.border,
              },
            ]}>
            <Text variant="caption" color={selected ? 'inverse' : 'secondary'}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    flexDirection: 'row',
    gap: Spacing.one,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});