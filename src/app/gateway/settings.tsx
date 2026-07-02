import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { DiscoveredGatewayRow } from '@/components/discovered-gateway-row';
import { CompactGatewayList } from '@/components/gateway/compact-gateway-list';
import { Button, Card, Screen, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useGatewaySettingsScreen } from '@/hooks/use-gateway-settings-screen';
import { useTokens } from '@/hooks/use-tokens';

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
  } = useGatewaySettingsScreen();

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.row}>
          <Text variant="caption">Connect automatically on launch</Text>
          <Switch
            value={settings.autoConnect}
            onValueChange={(value) => void setAutoConnect(value)}
            trackColor={{ true: tokens.accent, false: tokens.border }}
            thumbColor={tokens.textPrimary}
          />
        </View>

        {settings.tailscaleHost ? (
          <Card padding={Spacing.three} style={styles.card}>
            <Text variant="caption">Your PC</Text>
            <Text color="secondary">{settings.pcName ?? settings.tailscaleHost}</Text>
            <Text variant="mono" color="secondary">
              {settings.tailscaleHost}
            </Text>
            <Link href="/onboarding" asChild>
              <Pressable>
                <Text variant="link" color="accent">
                  Update PC or setup token
                </Text>
              </Pressable>
            </Link>
          </Card>
        ) : null}

        {deviceId ? (
          <Text variant="mono" color="tertiary">
            Device {deviceId.slice(0, 20)}...
          </Text>
        ) : null}

        <View style={styles.sectionHeader}>
          <Text variant="caption">Nearby</Text>
          <Pressable onPress={discovery.rescan}>
            <Text variant="caption" color="tertiary">
              {discovery.status === 'scanning' ? 'Scanning...' : 'Rescan'}
            </Text>
          </Pressable>
        </View>

        {discovery.status === 'unavailable' ? (
          <Card padding={Spacing.three}>
            <Text color="secondary">
              Local discovery needs a native build. Tailscale auto-connect still works.
            </Text>
          </Card>
        ) : discovery.gateways.length === 0 ? (
          <Card padding={Spacing.three}>
            <Text color="secondary">
              {discovery.status === 'scanning' ? 'Scanning local network...' : 'No nearby gateways found.'}
            </Text>
          </Card>
        ) : (
          discovery.gateways.map((gateway) => (
            <DiscoveredGatewayRow
              key={gateway.id}
              gateway={gateway}
              isScanning={discovery.status === 'scanning'}
              onAdd={() => void handleAddDiscovered(gateway.id)}
            />
          ))
        )}

        <View style={styles.sectionHeader}>
          <Text variant="caption">Saved gateways</Text>
          <Link href="/gateway/add" asChild>
            <Pressable>
              <Text variant="link" color="accent">
                Add manually
              </Text>
            </Pressable>
          </Link>
        </View>

        <CompactGatewayList
          gateways={gateways}
          activeGatewayId={activeGateway?.id}
          status={status}
          statusDetail={statusDetail}
          reachability={reachability}
          onSelect={(gateway) => void handleConnect(gateway.id)}
          onDelete={(gateway) => handleDelete(gateway.id)}
        />

        <Button label="Refresh" variant="ghost" onPress={() => void refreshGateways()} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.four,
    gap: Spacing.three,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  card: {
    borderRadius: Radius.lg,
    gap: Spacing.two,
  },
});
