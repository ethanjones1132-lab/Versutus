import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { TransportSecurityCard } from '@/components/gateway/transport-security-card';
import { Badge, Card, Icon, Screen, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';

export default function GatewaySettingsScreen() {
  const { activeGateway, settings, deviceId } = useGateway();

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.heading}>
          <Text variant="title">Gateway settings</Text>
          <Text variant="caption" color="secondary">
            Device identity and saved routes. Providers, CLI environments, and gateway management moved to Gate setup.
          </Text>
        </View>

        <Link href="/gateway/setup" asChild>
          <Pressable accessibilityRole="button">
            <Card variant="hero" padding={Spacing.three} style={styles.card}>
              <View style={styles.sectionHeading}>
                <View style={styles.sectionTitle}>
                  <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
                    Gate setup
                  </Text>
                  <Text variant="headline">Manage providers & gateways</Text>
                </View>
                <Icon name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={18} color="textTertiary" />
              </View>
              <Text variant="caption" color="secondary">
                Providers, CLI environments, saved gateways, and capability registry.
              </Text>
            </Card>
          </Pressable>
        </Link>

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

        <Card variant="surface" padding={Spacing.three} style={styles.card}>
          <View style={styles.sectionHeading}>
            <View style={styles.sectionTitle}>
              <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
                This build
              </Text>
              <Text variant="headline">Runtime environment</Text>
            </View>
          </View>
          <Text color="secondary">
            What this build&apos;s engine actually provides. Tests run elsewhere; only
            the device can answer for the device.
          </Text>
          <Link href="/gateway/diagnostics" asChild>
            <Pressable accessibilityRole="button">
              <Text variant="link" color="accent">
                Check runtime environment
              </Text>
            </Pressable>
          </Link>
        </Card>

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
