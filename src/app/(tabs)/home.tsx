import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GatewayHomeDashboard } from '@/components/gateway/gateway-home-dashboard';
import { ErrorCard, Screen, ScreenHeader } from '@/components/ui';
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
  const { gateways, status, refreshCapabilities, refreshGateways, reloadHistory } = useGateway();
  const [refreshing, setRefreshing] = useState(false);
  // A refused refresh read is named below the header instead of ending the
  // spinner as if the pull succeeded; cleared by the next success.
  const [refreshError, setRefreshError] = useState<string | null>(null);
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
    try {
      await Promise.all([refreshCapabilities(), refreshGateways(), reloadHistory()]);
      setRefreshError(null);
    } catch (caught) {
      setRefreshError(caught instanceof Error ? caught.message : String(caught));
    }
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
        subtitle={
          gateways.length === 0
            ? 'Connect your gateway'
            : status === 'connected'
              ? 'Connected'
              : status === 'connecting' || status === 'reconnecting'
                ? 'Connecting'
                : status === 'pairing'
                  ? 'Needs approval'
                  : 'Disconnected'
        }
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
        {refreshError ? (
          <ErrorCard
            cause={refreshError}
            affected="Home's gateway reads"
            next="Retry the refresh."
            onRetry={() => void onRefresh()}
            onDismiss={() => setRefreshError(null)}
          />
        ) : null}
        {/* Residual surface: GatewayHomeDashboard owns the thin status strip
            and overflow entries. With no gateway saved, its hero slot IS the
            empty state (connect CTA) and pairing/troubleshooting hang off it
            instead of a forked body. */}
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
