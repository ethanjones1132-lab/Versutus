import { Link } from 'expo-router';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { DiscoveredGatewayRow } from '@/components/discovered-gateway-row';
import { CompactGatewayList } from '@/components/gateway/compact-gateway-list';
import { Button, Card, ConfirmSheet, Divider, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useGatewaySettingsScreen } from '@/hooks/use-gateway-settings-screen';
import { useTokens } from '@/hooks/use-tokens';

export function GatewayManagementSection() {
  const tokens = useTokens();
  const {
    gateways,
    activeGateway,
    status,
    statusDetail,
    settings,
    discovery,
    reachability,
    setAutoConnect,
    refreshGateways,
    handleConnect,
    handleDelete,
    handleAddDiscovered,
    deleteCandidate,
    confirmDelete,
    cancelDelete,
  } = useGatewaySettingsScreen();

  return (
    <View style={styles.container}>
      <Card variant="hero" padding={Spacing.three} style={styles.card}>
        <View style={styles.sectionHeading}>
          <View style={styles.sectionTitle}>
            <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
              Startup
            </Text>
            <Text variant="headline">Automatic connection</Text>
          </View>
          <Switch
            value={settings.autoConnect}
            onValueChange={(value) => void setAutoConnect(value)}
            trackColor={{ true: tokens.accent, false: tokens.border }}
            thumbColor={tokens.textPrimary}
            accessibilityLabel="Connect automatically on launch"
          />
        </View>
        <Text variant="caption" color="secondary">
          Versutus probes saved profiles, Tailscale, and local discovery when the app opens.
        </Text>
      </Card>

      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitle}>
          <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
            Discovery
          </Text>
          <Text variant="headline">Nearby gateways</Text>
        </View>
        <Pressable onPress={discovery.rescan} accessibilityRole="button">
          <Text variant="link" color="accent">
            {discovery.status === 'scanning' ? 'Scanning…' : 'Rescan'}
          </Text>
        </Pressable>
      </View>

      {discovery.status === 'unavailable' ? (
        <Card variant="inset" padding={Spacing.three} style={styles.card}>
          <Text color="secondary">
            Local discovery needs a native build. Tailscale auto-connect still works.
          </Text>
        </Card>
      ) : discovery.gateways.length === 0 ? (
        <Card variant="inset" padding={Spacing.three} style={styles.card}>
          <Text color="secondary">
            {discovery.status === 'scanning' ? 'Scanning the local network…' : 'No nearby gateways found.'}
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

      <Divider />
      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitle}>
          <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
            Profiles
          </Text>
          <Text variant="headline">Saved gateways</Text>
        </View>
        <Link href="/gateway/add" asChild>
          <Pressable accessibilityRole="button">
            <Text variant="link" color="accent">
              Add gateway
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

      <Button label="Refresh saved profiles" variant="ghost" size="sm" onPress={() => void refreshGateways()} />

      <ConfirmSheet
        visible={deleteCandidate !== null}
        title="Remove gateway?"
        message={`${deleteCandidate?.name ?? 'This gateway'} will stay available if discovered again.`}
        confirmLabel="Remove"
        danger
        onCancel={cancelDelete}
        onConfirm={confirmDelete}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.three,
  },
  card: {
    borderRadius: Radius.lg,
    gap: Spacing.two,
  },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  sectionTitle: {
    flex: 1,
    gap: Spacing.one,
  },
  eyebrow: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
});
