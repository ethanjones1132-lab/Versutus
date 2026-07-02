import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import Animated, { Layout } from 'react-native-reanimated';

import { VersutusLogotype } from '@/components/brand';
import {
  CONNECTION_TIMELINE_STEPS_LONG,
  ConnectionTimeline,
} from '@/components/connection-timeline';
import { Button, Card, Screen, Text, TextField } from '@/components/ui';
import { Motion, Radius, Spacing } from '@/constants/tokens';
import { phaseToTimelineStep } from '@/lib/connection/phase';
import { entering } from '@/lib/motion/presets';
import { useGateway } from '@/context/gateway-provider';
import { validatePcAddress } from '@/lib/onboarding/validate-pc-address';
import { useTokens } from '@/hooks/use-tokens';

export default function OnboardingScreen() {
  const router = useRouter();
  const tokens = useTokens();
  const { setupFromPcAddress, probeMessage, connectionPhase, settings } = useGateway();
  const [pcAddress, setPcAddress] = useState(settings.tailscaleHost ?? '');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const validation = useMemo(() => validatePcAddress(pcAddress), [pcAddress]);
  const busy = working || connectionPhase === 'searching' || connectionPhase === 'connecting';
  const activeTimelineStep = phaseToTimelineStep(connectionPhase);

  async function handleContinue() {
    if (!validation.valid) return;

    setError(null);
    setWorking(true);
    try {
      const ok = await setupFromPcAddress(pcAddress, token);
      if (ok) {
        router.replace('/(tabs)/chat');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.content}>
          <Card variant="hero" padding={Spacing.four} style={styles.hero}>
            <VersutusLogotype
              tagline="Your OpenClaw gateway, always within reach over Tailscale."
            />
          </Card>

          <Card padding={Spacing.four} style={styles.formCard}>
            <Text variant="headline">Connect to your PC</Text>
            <Text color="secondary" style={styles.lead}>
              Enter your PC&apos;s Tailscale address. Versutus handles TLS, discovery, and pairing from there.
            </Text>

            <View style={styles.field}>
              <Text variant="caption" color="secondary">
                PC Tailscale address
              </Text>
              <TextField
                value={pcAddress}
                onChangeText={setPcAddress}
                placeholder="ethanspc.tail3a1a8a.ts.net"
                autoCapitalize="none"
                autoCorrect={false}
                validationState={
                  !pcAddress.trim() ? 'default' : validation.valid ? 'valid' : 'invalid'
                }
              />
              <Text variant="caption" color={validation.valid ? 'accent' : 'accentWarm'}>
                {validation.message}
              </Text>
            </View>

            <View style={styles.field}>
              <Text variant="caption" color="secondary">
                Desktop setup token
              </Text>
              <TextField
                value={token}
                onChangeText={setToken}
                placeholder="Paste token or setup link from your PC"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
              <Text variant="caption" color="tertiary">
                Required when the desktop gateway has auth enabled.
              </Text>
            </View>

            <ConnectionTimeline
              activeStep={activeTimelineStep}
              busy={busy}
              steps={CONNECTION_TIMELINE_STEPS_LONG}
            />

            {probeMessage ? (
              <Animated.View
                layout={Layout.duration(Motion.duration.normal)}
                entering={entering.fadeIn}
                exiting={entering.fadeOut}
                style={[styles.statusCard, { backgroundColor: tokens.backgroundInset }]}>
                {busy ? <ActivityIndicator color={tokens.accent} /> : null}
                <Text color="secondary">{probeMessage}</Text>
              </Animated.View>
            ) : null}

            {error ? (
              <Text color="accentWarm" variant="caption">
                {error}
              </Text>
            ) : null}

            <Button
              label={busy ? 'Connecting…' : 'Connect automatically'}
              onPress={() => void handleContinue()}
              disabled={busy || !validation.valid}
            />
          </Card>

          <Text color="tertiary" variant="caption" style={styles.footnote}>
            Versutus will try Tailscale (wss) and local network automatically. You only approve this phone once on your
            PC.
          </Text>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  keyboard: {
    flex: 1,
  },
  content: {
    flex: 1,
    padding: Spacing.four,
    gap: Spacing.three,
    justifyContent: 'center',
  },
  hero: {
    alignItems: 'center',
    borderRadius: Radius.xl,
    gap: Spacing.two,
  },
  formCard: {
    borderRadius: Radius.xl,
    gap: Spacing.three,
  },
  lead: {
    lineHeight: 22,
  },
  field: {
    gap: Spacing.two,
  },
  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radius.md,
  },
  footnote: {
    lineHeight: 20,
    textAlign: 'center',
  },
});
