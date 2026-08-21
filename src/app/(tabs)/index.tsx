import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet } from 'react-native';

import { GatewayHomeDashboard } from '@/components/gateway/gateway-home-dashboard';
import { GlassCollapsible } from '@/components/glass-collapsible';
import { HomeStatusCard } from '@/components/home-status-card';
import { PairingPanel } from '@/components/pairing-panel';
import { Button, Screen, ScreenHeader, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useGatewayDiscovery } from '@/hooks/use-gateway-discovery';
import { useTokens } from '@/hooks/use-tokens';
import { isGatewayTokenRequiredMessage } from '@/lib/gateway/errors';
import { useAmbientParallaxScroll } from '@/lib/motion/ambient-parallax';

export default function HomeScreen() {
  const router = useRouter();
  const tokens = useTokens();
  const {
    gateways,
    settings,
    status,
    statusDetail,
    connectionPhase,
    probeMessage,
    deviceId,
    pairingDetails,
    lastError,
    retryAutoConnect,
    refreshCapabilities,
    refreshGateways,
    reloadHistory,
  } = useGateway();
  const [refreshing, setRefreshing] = useState(false);
  const { parallaxY, onScroll } = useAmbientParallaxScroll();
  const discovery = useGatewayDiscovery(true);
  const needsSetupAction = !settings.tailscaleHost || isGatewayTokenRequiredMessage(lastError);
  const hasSavedGateway = gateways.length > 0;

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
        subtitle={hasSavedGateway ? 'Command center' : 'Connect your gateway'}
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
        {hasSavedGateway ? (
          <GatewayHomeDashboard />
        ) : (
          <>
            <HomeStatusCard
              pcName={settings.pcName}
              phase={connectionPhase}
              status={status}
              statusDetail={statusDetail}
              probeMessage={probeMessage}
              onConnect={() => void retryAutoConnect()}
              onOpenChat={() => router.push('/chat')}
            />

            {status === 'pairing' && deviceId ? (
              <PairingPanel deviceId={deviceId} pairingDetails={pairingDetails} />
            ) : null}

            {lastError && connectionPhase === 'failed' ? (
              <GlassCollapsible title="Troubleshooting">
                <Text color="secondary">
                  - Hermes (or Gate) listening on the PC{'\n'}- API key matches API_SERVER_KEY (or Gate token)
                  {'\n'}- Phone and PC on the same Tailscale tailnet{'\n'}- Tailscale Serve / LAN URL reachable from
                  the phone{'\n'}- If Hermes reports running but nothing answers: restart the gateway on the PC
                </Text>
                <Text variant="caption" color="tertiary">
                  {lastError}
                </Text>
              </GlassCollapsible>
            ) : null}

            {discovery.gateways.length > 0 ? (
              <GlassCollapsible title="Found on your network">
                <Text color="secondary">
                  {discovery.gateways.length} gateway{discovery.gateways.length === 1 ? '' : 's'} nearby - Versutus
                  will use them automatically when connecting.
                </Text>
              </GlassCollapsible>
            ) : null}

            {needsSetupAction ? (
              <Link href="/onboarding" asChild>
                <Button
                  label={settings.tailscaleHost ? 'Update setup token' : 'Set up PC address'}
                  variant="secondary"
                />
              </Link>
            ) : null}
          </>
        )}
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
