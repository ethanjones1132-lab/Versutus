import { ScrollView, StyleSheet } from 'react-native';

import { CapabilitiesSection } from '@/components/gateway/capabilities-section';
import { ToolsetsSection } from '@/components/gateway/toolsets-section';
import { Screen, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

/**
 * Standalone route for the capability registry. The Gate setup hub renders
 * the same CapabilitiesSection inline on its tab — this route stays for deep
 * links and anyone arriving straight at /gateway/capabilities.
 */
export default function CapabilityEditorScreen() {
  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Text variant="title">Capabilities</Text>
        <Text variant="caption" color="secondary">
          Create, edit, and delete Gate capability instances. Provider auth and CLI environments have dedicated screens.
        </Text>
        <CapabilitiesSection />
        <ToolsetsSection />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.four,
    gap: Spacing.three,
  },
});
