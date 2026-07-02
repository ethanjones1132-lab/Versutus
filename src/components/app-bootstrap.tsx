import { Redirect, useSegments } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { VersutusMark } from '@/components/brand/versutus-mark';
import { Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';

export function AppBootstrap({ children }: { children: React.ReactNode }) {
  const segments = useSegments();
  const tokens = useTokens();
  const { isBootstrapped, needsOnboarding } = useGateway();

  if (!isBootstrapped) {
    return (
      <View style={[styles.boot, { backgroundColor: tokens.background }]}>
        <VersutusMark size={64} />
        <ActivityIndicator color={tokens.accent} size="large" />
        <Text color="secondary">Starting Versutus…</Text>
      </View>
    );
  }

  const rootSegment = segments[0];
  const onOnboarding = rootSegment === 'onboarding';
  const onDev = __DEV__ && rootSegment === 'dev';
  if (needsOnboarding && !onOnboarding && !onDev) {
    return <Redirect href="/onboarding" />;
  }

  return children;
}

const styles = StyleSheet.create({
  boot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
});
