import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Link } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { DeviceIdRow } from '@/components/device-id-row';
import { SpendEntryRow } from '@/components/gateway/spend-entry-row';
import { TransportSecurityCard } from '@/components/gateway/transport-security-card';
import { Badge, Card, Icon, Screen, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import {
  APP_LOCK_LABEL,
  APP_LOCK_SUMMARY,
  appLockUnavailableCopy,
  saveAppLock,
  type AppLockUnavailableReason,
} from '@/lib/settings/app-lock';
import { deviceAppLockState } from '@/lib/settings/app-lock-device';

export default function GatewaySettingsScreen() {
  const { activeGateway, settings, deviceId } = useGateway();
  const tokens = useTokens();
  const [copied, setCopied] = useState<'id' | null>(null);
  const [appLock, setAppLock] = useState(false);
  const [appLockReason, setAppLockReason] = useState<AppLockUnavailableReason | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The stored flag is read against what THIS device can answer, so a lock
    // whose enrollment was removed shows the reason line rather than a switch
    // that claims the lock is holding.
    void (async () => {
      const state = await deviceAppLockState();
      if (cancelled) return;
      setAppLock(state.enabled);
      setAppLockReason(state.reason);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAppLock = useCallback((next: boolean) => {
    setAppLock(next);
    void saveAppLock(next);
  }, []);

  const copyText = useCallback(async (text: string) => {
    await Clipboard.setStringAsync(text);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied('id');
    setTimeout(() => setCopied(null), 2000);
  }, []);

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

        <SpendEntryRow />

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

        <Card variant="surface" padding={Spacing.three} style={styles.card}>
          <View style={styles.sectionHeading}>
            <View style={styles.sectionTitle}>
              <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
                Privacy
              </Text>
              <Text variant="headline">{APP_LOCK_LABEL}</Text>
            </View>
          </View>
          <Text color="secondary">{APP_LOCK_SUMMARY}</Text>
          {appLockReason ? (
            // A device that cannot ask for a fingerprint or Face ID gets the
            // module's own line, never a switch that could not finish.
            <Text variant="caption" color="tertiary">
              {appLockUnavailableCopy(appLockReason)}
            </Text>
          ) : (
            <Switch
              value={appLock}
              onValueChange={handleAppLock}
              trackColor={{ true: tokens.accent, false: tokens.border }}
              thumbColor={tokens.textPrimary}
              accessibilityLabel={APP_LOCK_LABEL}
              accessibilityState={{ checked: appLock }}
            />
          )}
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
                <DeviceIdRow deviceId={deviceId} copied={copied} onCopy={copyText} />
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
