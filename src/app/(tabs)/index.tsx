import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GatewayHomeDashboard } from '@/components/gateway/gateway-home-dashboard';
import { Screen, ScreenHeader } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import { useAmbientParallaxScroll } from '@/lib/motion/ambient-parallax';
import { screenEdgesFor } from '@/lib/motion/screen-edges';
import { tabContentPaddingBottom } from '@/lib/motion/tab-insets';
import { stampAllLastSeen } from '@/lib/home/last-seen';

export default function HomeScreen() {
  const router = useRouter();
  const tokens = useTokens();
  const { gateways, refreshCapabilities, refreshGateways, reloadHistory } = useGateway();
  const [refreshing, setRefreshing] = useState(false);
  const { parallaxY, onScroll } = useAmbientParallaxScroll();
  const insets = useSafeAreaInsets();

  // The digest reads lastSeenAt when the operator NEXT arrives, so leaving
  // Home is when the stamp lands: on unmount (navigate to another tab) and
  // when the app backgrounds. Latest gateway ids via ref — the unmount
  // cleanup must not depend on a state that changed after it captured.
  const gatewayIdsRef = useRef<string[]>([]);
  useEffect(() => {
    gatewayIdsRef.current = gateways.map((gateway) => gateway.id);
  }, [gateways]);

  useEffect(() => {
    return () => void stampAllLastSeen(gatewayIdsRef.current);
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') void stampAllLastSeen(gatewayIdsRef.current);
    });
    return () => subscription.remove();
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    const started = Date.now();
    await Promise.all([refreshCapabilities(), refreshGateways(), reloadHistory()]).catch(() => undefined);
    const elapsed = Date.now() - started;
    if (elapsed < 400) await new Promise((resolve) => setTimeout(resolve, 400 - elapsed));
    setRefreshing(false);
  };

  return (
    <Screen
      edges={screenEdgesFor({ platform: Platform.OS, hasDock: false })}
      parallaxY={parallaxY}>
      <ScreenHeader
        title="Versutus"
        subtitle={gateways.length > 0 ? 'Command center' : 'Connect your gateway'}
        onTrailingPress={() => router.push('/gateway/settings')}
      />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: tabContentPaddingBottom({ platform: Platform.OS, insetBottom: insets.bottom }) }]}
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
