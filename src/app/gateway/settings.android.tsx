import {
  Column,
  Host,
  HorizontalDivider,
  LazyColumn,
  ListItem,
  Switch,
  Text as ComposeText,
  TextButton,
} from '@expo/ui/jetpack-compose';
import * as Haptics from 'expo-haptics';
import { StyleSheet, View } from 'react-native';

import { Screen } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGatewaySettingsScreen } from '@/hooks/use-gateway-settings-screen';
import { useTokens } from '@/hooks/use-tokens';
import type { GatewayReachability } from '@/lib/gateway/dashboard';
import type { ConnectionStatus } from '@/lib/gateway/types';

async function tapHaptic() {
  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

function reachabilityLine(reachability?: GatewayReachability): string {
  if (!reachability) return 'Unknown';
  switch (reachability.state) {
    case 'connected':
      return 'Connected';
    case 'reachable':
      return reachability.latencyMs ? `Reachable · ${reachability.latencyMs} ms` : 'Reachable';
    case 'unreachable':
      return reachability.error ? `Offline · ${reachability.error}` : 'Offline';
    case 'checking':
      return 'Checking…';
    default:
      return 'Unknown';
  }
}

function statusLine(status: ConnectionStatus, detail?: string): string {
  const labels: Record<ConnectionStatus, string> = {
    connected: 'Connected',
    connecting: 'Connecting',
    reconnecting: 'Reconnecting',
    pairing: 'Needs approval',
    disconnected: 'Disconnected',
  };
  return detail ? `${labels[status]} · ${detail}` : labels[status];
}

export default function GatewaySettingsScreen() {
  const tokens = useTokens();
  const {
    gateways,
    activeGateway,
    status,
    statusDetail,
    settings,
    deviceId,
    discovery,
    reachability,
    setAutoConnect,
    refreshGateways,
    handleConnect,
    handleDelete,
    handleAddDiscovered,
    router,
  } = useGatewaySettingsScreen();

  const showConnectionError =
    activeGateway && status !== 'connected' && status !== 'connecting' && status !== 'reconnecting';

  const listColors = {
    containerColor: tokens.background,
    contentColor: tokens.textPrimary,
    supportingContentColor: tokens.textSecondary,
    overlineContentColor: tokens.textTertiary,
  };

  return (
    <Screen>
      <View style={styles.root}>
        <Host style={styles.listHost}>
          <LazyColumn
            contentPadding={{
              start: Spacing.four,
              end: Spacing.four,
              top: Spacing.two,
              bottom: Spacing.five,
            }}
            verticalArrangement={{ spacedBy: 4 }}>
            <ListItem colors={listColors}>
              <ListItem.HeadlineContent>
                <ComposeText color={tokens.textPrimary}>Connect automatically on launch</ComposeText>
              </ListItem.HeadlineContent>
              <ListItem.TrailingContent>
                <Switch value={settings.autoConnect} onCheckedChange={(value) => void setAutoConnect(value)} />
              </ListItem.TrailingContent>
            </ListItem>

            {settings.tailscaleHost ? (
              <ListItem colors={listColors}>
                <ListItem.OverlineContent>
                  <ComposeText color={tokens.textTertiary}>Your PC</ComposeText>
                </ListItem.OverlineContent>
                <ListItem.HeadlineContent>
                  <ComposeText color={tokens.textPrimary}>{settings.pcName ?? settings.tailscaleHost}</ComposeText>
                </ListItem.HeadlineContent>
                <ListItem.SupportingContent>
                  <ComposeText color={tokens.textSecondary}>{settings.tailscaleHost}</ComposeText>
                </ListItem.SupportingContent>
              </ListItem>
            ) : null}

            {deviceId ? (
              <ListItem colors={listColors}>
                <ListItem.OverlineContent>
                  <ComposeText color={tokens.textTertiary}>Device</ComposeText>
                </ListItem.OverlineContent>
                <ListItem.SupportingContent>
                  <ComposeText color={tokens.textSecondary}>
                    {deviceId.length > 24 ? `${deviceId.slice(0, 20)}…` : deviceId}
                  </ComposeText>
                </ListItem.SupportingContent>
              </ListItem>
            ) : null}

            {settings.tailscaleHost ? (
              <ListItem colors={listColors}>
                <ListItem.HeadlineContent>
                  <Host matchContents>
                    <TextButton onClick={() => router.push('/onboarding')}>
                      <ComposeText color={tokens.accent}>Update PC or setup token</ComposeText>
                    </TextButton>
                  </Host>
                </ListItem.HeadlineContent>
              </ListItem>
            ) : null}

            {showConnectionError ? (
              <ListItem
                colors={{
                  ...listColors,
                  containerColor: tokens.accentWarmMuted,
                  supportingContentColor: tokens.textSecondary,
                }}>
                <ListItem.OverlineContent>
                  <ComposeText color={tokens.accentWarm}>Connection issue</ComposeText>
                </ListItem.OverlineContent>
                <ListItem.SupportingContent>
                  <ComposeText color={tokens.textSecondary}>
                    Cause: {statusDetail || statusLine(status)}. Affected: {activeGateway?.name ?? 'gateway'}.
                    Next: Reconnect below or check Tailscale/PC.
                  </ComposeText>
                </ListItem.SupportingContent>
              </ListItem>
            ) : null}

            <HorizontalDivider color={tokens.glassBorder} />

            <ListItem colors={listColors}>
              <ListItem.OverlineContent>
                <ComposeText color={tokens.textTertiary}>Nearby</ComposeText>
              </ListItem.OverlineContent>
              <ListItem.TrailingContent>
                <Host matchContents>
                  <TextButton
                    onClick={async () => {
                      await tapHaptic();
                      discovery.rescan();
                    }}>
                    <ComposeText color={tokens.textTertiary}>
                      {discovery.status === 'scanning' ? 'Scanning…' : 'Rescan'}
                    </ComposeText>
                  </TextButton>
                </Host>
              </ListItem.TrailingContent>
            </ListItem>

            {discovery.status === 'unavailable' ? (
              <ListItem colors={listColors}>
                <ListItem.SupportingContent>
                  <ComposeText color={tokens.textSecondary}>
                    Local discovery needs a native build. Tailscale auto-connect still works.
                  </ComposeText>
                </ListItem.SupportingContent>
              </ListItem>
            ) : discovery.gateways.length === 0 ? (
              <ListItem colors={listColors}>
                <ListItem.SupportingContent>
                  <ComposeText color={tokens.textSecondary}>
                    {discovery.status === 'scanning' ? 'Scanning local network…' : 'No nearby gateways found.'}
                  </ComposeText>
                </ListItem.SupportingContent>
              </ListItem>
            ) : (
              discovery.gateways.map((gateway) => (
                <ListItem key={gateway.id} colors={listColors}>
                  <ListItem.HeadlineContent>
                    <ComposeText color={tokens.textPrimary}>{gateway.name}</ComposeText>
                  </ListItem.HeadlineContent>
                  <ListItem.SupportingContent>
                    <ComposeText color={tokens.textSecondary}>{gateway.url}</ComposeText>
                  </ListItem.SupportingContent>
                  <ListItem.TrailingContent>
                    <Host matchContents>
                      <TextButton
                        onClick={async () => {
                          await tapHaptic();
                          void handleAddDiscovered(gateway.id);
                        }}>
                        <ComposeText color={tokens.accent}>Add</ComposeText>
                      </TextButton>
                    </Host>
                  </ListItem.TrailingContent>
                </ListItem>
              ))
            )}

            <HorizontalDivider color={tokens.glassBorder} />

            <ListItem colors={listColors}>
              <ListItem.OverlineContent>
                <ComposeText color={tokens.textTertiary}>Saved gateways</ComposeText>
              </ListItem.OverlineContent>
              <ListItem.TrailingContent>
                <Host matchContents>
                  <TextButton onClick={() => router.push('/gateway/add')}>
                    <ComposeText color={tokens.accent}>Add manually</ComposeText>
                  </TextButton>
                </Host>
              </ListItem.TrailingContent>
            </ListItem>

            {gateways.length === 0 ? (
              <ListItem colors={listColors}>
                <ListItem.SupportingContent>
                  <ComposeText color={tokens.textSecondary}>
                    No saved gateways yet — auto-connect will create one.
                  </ComposeText>
                </ListItem.SupportingContent>
              </ListItem>
            ) : (
              gateways.map((gateway) => {
                const isActive = activeGateway?.id === gateway.id;
                const rowStatus = isActive ? status : 'disconnected';
                const gatewayReachability = reachability[gateway.id];
                const reachabilitySuffix = isActive
                  ? ''
                  : `\n${reachabilityLine(gatewayReachability)}`;

                return (
                  <ListItem
                    key={gateway.id}
                    colors={{
                      ...listColors,
                      containerColor: isActive ? tokens.accentMuted : tokens.background,
                    }}
                    tonalElevation={isActive ? 2 : 0}>
                    <ListItem.HeadlineContent>
                      <ComposeText color={tokens.textPrimary}>{gateway.name}</ComposeText>
                    </ListItem.HeadlineContent>
                    <ListItem.SupportingContent>
                      <ComposeText color={tokens.textSecondary}>
                        {gateway.url}
                        {isActive ? `\n${statusLine(rowStatus, statusDetail)}` : reachabilitySuffix}
                      </ComposeText>
                    </ListItem.SupportingContent>
                    <ListItem.TrailingContent>
                      <Host matchContents>
                        <Column>
                          <TextButton
                            onClick={async () => {
                              await tapHaptic();
                              void handleConnect(gateway.id);
                            }}>
                            <ComposeText color={tokens.accent}>{isActive ? 'Reconnect' : 'Connect'}</ComposeText>
                          </TextButton>
                          <TextButton
                            onClick={async () => {
                              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                              handleDelete(gateway.id);
                            }}>
                            <ComposeText color={tokens.statusDisconnected}>Remove</ComposeText>
                          </TextButton>
                        </Column>
                      </Host>
                    </ListItem.TrailingContent>
                  </ListItem>
                );
              })
            )}

            <ListItem colors={listColors}>
              <ListItem.HeadlineContent>
                <Host matchContents>
                  <TextButton
                    onClick={async () => {
                      await tapHaptic();
                      void refreshGateways();
                    }}>
                    <ComposeText color={tokens.textSecondary}>Refresh gateway list</ComposeText>
                  </TextButton>
                </Host>
              </ListItem.HeadlineContent>
            </ListItem>
          </LazyColumn>
        </Host>
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
});
