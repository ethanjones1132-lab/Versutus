import { useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet } from 'react-native';

import { GatewayHomeDashboard } from '@/components/gateway/gateway-home-dashboard';
import { Screen, ScreenHeader } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import { useAmbientParallaxScroll } from '@/lib/motion/ambient-parallax';

export default function HomeScreen() {
  const router = useRouter();
  const tokens = useTokens();
  const { gateways, refreshCapabilities, refreshGateways, reloadHistory } = useGateway();
  const [refreshing, setRefreshing] = useState(false);
  const { parallaxY, onScroll } = useAmbientParallaxScroll();

  const onRefresh = async () => {
    setRefreshing(true);
    const started = Date.now();
    await Promise.all([refreshCapabilities(), refreshGateways(), reloadHistory()]).catch(() => undefined);
    const elapsed = Date.now() - started;
    if (elapsed < 400) await new Promise((resolve) => setTimeout(resolve, 400 - elapsed));
    setRefreshing(false);
  };

  return (
    <Screen parallaxY={parallaxY}>
      <ScreenHeader
        title="Versutus"
        subtitle={gateways.length > 0 ? 'Command center' : 'Connect your gateway'}
        onTrailingPress={() => router.push('/gateway/settings')}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        onScroll={onScroll}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={tokens.accentWarm}
            colors={[tokens.accentWarm]}
            progressBackgroundColor={tokens.backgroundElevated}
          />
        }>
        {/* Single home surface: GatewayHomeDashboard owns both states. With no
            gateway saved, its hero slot IS the empty state (connect CTA) and
            pairing/troubleshooting hang off it instead of a forked body. */}
        <GatewayHomeDashboard />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
    gap: Spacing.three,
  },
});
