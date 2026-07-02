import { Link, useRouter } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';

import { GatewayHomeDashboard } from '@/components/gateway/gateway-home-dashboard';
import { GlassCollapsible } from '@/components/glass-collapsible';
import { HomeStatusCard } from '@/components/home-status-card';
import { PairingPanel } from '@/components/pairing-panel';
import { Button, Screen, ScreenHeader, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useGatewayDiscovery } from '@/hooks/use-gateway-discovery';
import { isGatewayTokenRequiredMessage } from '@/lib/gateway/errors';

export default function HomeScreen() {
  const router = useRouter();
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
  } = useGateway();
  const discovery = useGatewayDiscovery(true);
  const needsSetupAction = !settings.tailscaleHost || isGatewayTokenRequiredMessage(lastError);
  const hasSavedGateway = gateways.length > 0;

  return (
    <Screen edges={['bottom']}>
      <ScreenHeader onTrailingPress={() => router.push('/gateway/settings')} style={styles.header} />
      <ScrollView contentContainerStyle={styles.content}>
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
                  - OpenClaw gateway running on your PC{'\n'}- Tailscale connected on both devices{'\n'}- Gateway
                  reachable over tailnet (bind=loopback with Tailscale Serve){'\n'}- Approve this phone if prompted
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
  header: {
    justifyContent: 'flex-end',
    paddingTop: Spacing.one,
  },
  content: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
    gap: Spacing.three,
  },
});
