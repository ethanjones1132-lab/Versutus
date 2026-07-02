import { AssistChip, Host, Text } from '@expo/ui/jetpack-compose';
import * as Haptics from 'expo-haptics';
import { StyleSheet } from 'react-native';

import { useTokens } from '@/hooks/use-tokens';

export function CommandChip({ label, onPress }: { label: string; onPress: () => void }) {
  const tokens = useTokens();

  return (
    <Host matchContents style={styles.host}>
      <AssistChip
        onClick={async () => {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onPress();
        }}
        colors={{
          containerColor: tokens.backgroundElevated,
          labelColor: tokens.textPrimary,
        }}>
        <AssistChip.Label>
          <Text color={tokens.textPrimary} style={{ fontSize: 13 }}>
            {label}
          </Text>
        </AssistChip.Label>
      </AssistChip>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    alignSelf: 'flex-start',
  },
});