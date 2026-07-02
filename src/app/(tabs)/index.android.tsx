/**
 * Pass 1 plan:
 * 1. LazyColumn surface language (no ScrollView seam)
 * 2. Native M3 FAB for settings
 * 3. Hero status + collapsible discovery/troubleshooting via Android splits
 * 4. Token-driven spacing; compact bottom inset for FAB
 */
import {
  FloatingActionButton,
  Host,
  LazyColumn,
  Text as ComposeText,
} from '@expo/ui/jetpack-compose';
import * as Haptics from 'expo-haptics';
import { Link, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { GatewayHomeDashboard } from '@/components/gateway/gateway-home-dashboard';
import { GlassCollapsible } from '@/components/glass-collapsible';
import { HomeStatusCard } from '@/components/home-status-card';
import { PairingPanel } from '@/components/pairing-panel';
import { Button, Screen, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useGatewayDiscovery } from '@/hooks/use-gateway-discovery';
import { useTokens } from '@/hooks/use-tokens';
import { isGatewayTokenRequiredMessage } from '@/lib/gateway/errors';

function SettingsFab({ onPress }: { onPress: () => void }) {
  const tokens = useTokens();

  return (
    <Host matchContents style={styles.fabHost}>
      <FloatingActionButton
        containerColor={tokens.backgroundElevated}
        onClick={async () => {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onPress();
        }}>
        <FloatingActionButton.Icon>
          <ComposeText color={tokens.accent} style={{ fontSize: 20, fontWeight: '600' }}>
            ⚙
          </ComposeText>
        </FloatingActionButton.Icon>
      </FloatingActionButton>
    </Host>
  );
}

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
      <View style={styles.root}>
        <Host style={styles.listHost}>
          <LazyColumn
            contentPadding={{
              start: Spacing.four,
              end: Spacing.four,
              top: Spacing.four,
              bottom: Spacing.six + 72,
            }}
            verticalArrangement={{ spacedBy: Spacing.three }}>
            {hasSavedGateway ? (
              <Host matchContents style={styles.sectionHost}>
                <GatewayHomeDashboard />
              </Host>
            ) : (
              <>
                <Host matchContents style={styles.sectionHost}>
                  <HomeStatusCard
                    pcName={settings.pcName}
                    phase={connectionPhase}
                    status={status}
                    statusDetail={statusDetail}
                    probeMessage={probeMessage}
                    onConnect={() => void retryAutoConnect()}
                    onOpenChat={() => router.push('/chat')}
                  />
                </Host>

                {status === 'pairing' && deviceId ? (
                  <Host matchContents style={styles.sectionHost}>
                    <PairingPanel deviceId={deviceId} pairingDetails={pairingDetails} />
                  </Host>
                ) : null}

                {lastError && connectionPhase === 'failed' ? (
                  <Host matchContents style={styles.sectionHost}>
                    <GlassCollapsible title="Troubleshooting">
                      <Text color="secondary">
                        Cause: {lastError}. Affected: gateway connection. Next: ensure OpenClaw is running, Tailscale is
                        connected on both devices, and approve this phone if prompted.
                      </Text>
                      <Text variant="caption" color="tertiary">
                        - OpenClaw gateway running on your PC{'\n'}- Tailscale connected on both devices{'\n'}- Gateway
                        reachable over tailnet (bind=loopback with Tailscale Serve){'\n'}- Approve this phone if prompted
                      </Text>
                    </GlassCollapsible>
                  </Host>
                ) : null}

                {discovery.gateways.length > 0 ? (
                  <Host matchContents style={styles.sectionHost}>
                    <GlassCollapsible title="Found on your network">
                      <Text color="secondary">
                        {discovery.gateways.length} gateway{discovery.gateways.length === 1 ? '' : 's'} nearby —
                        Versutus will use them automatically when connecting.
                      </Text>
                    </GlassCollapsible>
                  </Host>
                ) : null}

                {needsSetupAction ? (
                  <Host matchContents style={styles.sectionHost}>
                    <Link href="/onboarding" asChild>
                      <Button
                        label={settings.tailscaleHost ? 'Update setup token' : 'Set up PC address'}
                        variant="secondary"
                      />
                    </Link>
                  </Host>
                ) : null}
              </>
            )}
          </LazyColumn>
        </Host>

        <View style={[styles.fabLayer, { pointerEvents: 'box-none' }]}>
          <SettingsFab onPress={() => router.push('/gateway/settings')} />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  listHost: {
    flex: 1,
    alignSelf: 'stretch',
  },
  sectionHost: {
    alignSelf: 'stretch',
  },
  fabLayer: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
    paddingRight: Spacing.four,
    paddingBottom: Spacing.four,
  },
  fabHost: {
    alignSelf: 'flex-end',
  },
});