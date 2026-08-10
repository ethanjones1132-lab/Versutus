import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { DiscoveredGatewayRow } from '@/components/discovered-gateway-row';
import { CompactGatewayList } from '@/components/gateway/compact-gateway-list';
import { TransportSecurityCard } from '@/components/gateway/transport-security-card';
import { Badge, Button, Card, Divider, Icon, Screen, Text } from '@/components/ui';
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
        <View style={styles.heading}>
          <Text variant="title">Gateway settings</Text>
          <Text variant="caption" color="secondary">
            Control discovery, saved profiles, and the device identity used for pairing.
          </Text>
        </View>

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

        {settings.tailscaleHost ? (
          <Card variant="surface" padding={Spacing.three} style={styles.card}>
            <View style={styles.sectionHeading}>
              <View style={styles.sectionTitle}>
                <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
                  Primary route
                </Text>
                <Text variant="headline">Your PC</Text>
              </View>
              <Badge label="Saved" tone="success" dot={false} />
            </View>
            <Text color="secondary">{settings.pcName ?? settings.tailscaleHost}</Text>
            <Text variant="mono" color="tertiary">
              {settings.tailscaleHost}
            </Text>
            <Link href="/onboarding" asChild>
              <Pressable accessibilityRole="button">
                <Text variant="link" color="accent">
                  Update address or API key
                </Text>
              </Pressable>
            </Link>
          </Card>
        ) : null}

        {activeGateway ? (
          <>
            <TransportSecurityCard url={activeGateway.url} tlsFingerprint={activeGateway.tlsFingerprint} />
            <Card variant="inset" padding={Spacing.three} style={styles.card}>
              <View style={styles.sectionHeading}>
                <View style={styles.sectionTitle}>
                  <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
                    Device identity
                  </Text>
                  <Text variant="headline">This device</Text>
                </View>
                <Icon name={{ ios: 'iphone', android: 'smartphone', web: 'smartphone' }} size={18} color="accentWarm" />
              </View>
              {deviceId ? (
                <Text variant="mono" color="secondary">
                  {deviceId}
                </Text>
              ) : (
                <Text variant="caption" color="tertiary">
                  Loading device identity…
                </Text>
              )}
              <Text variant="micro" color="tertiary">
                Used for gateway pairing and access requests. The private key remains in secure storage.
              </Text>
            </Card>
          </>
        ) : null}

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
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.four,
    gap: Spacing.three,
  },
  heading: {
    gap: Spacing.one,
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
