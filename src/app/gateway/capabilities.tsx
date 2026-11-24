import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';

import { CapabilitiesSection } from '@/components/gateway/capabilities-section';
import { RpcMethodsSection } from '@/components/gateway/rpc-methods-section';
import { ToolsetsSection } from '@/components/gateway/toolsets-section';
import { AppHeader, Icon, PressableScale, Screen, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useHeaderScrolled } from '@/hooks/use-header-scrolled';

/**
 * Standalone route for the capability registry. The Gate setup hub renders
 * the same CapabilitiesSection inline on its tab — this route stays for deep
 * links and anyone arriving straight at /gateway/capabilities.
 */
export default function CapabilityEditorScreen() {
  const router = useRouter();
  const { scrolled, onScroll } = useHeaderScrolled();

  return (
    <Screen>
      <AppHeader
        variant="compact"
        title="Capabilities"
        leading={
          <PressableScale
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/gateway/setup'))}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Back to Gate setup">
            <Icon
              name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
              size={20}
              color="textPrimary"
            />
          </PressableScale>
        }
        scrolled={scrolled}
      />
      <ScrollView contentContainerStyle={styles.content} onScroll={onScroll} scrollEventThrottle={16}>
        <Text variant="caption" color="secondary">
          Create, edit, and delete Gate capability instances. Provider auth and CLI environments have dedicated screens.
        </Text>
        <CapabilitiesSection />
        <ToolsetsSection />
        <RpcMethodsSection />
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
