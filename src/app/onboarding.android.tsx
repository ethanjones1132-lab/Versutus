/**
 * Pass 1 plan:
 * 1. Single hero card — unified Compose surface, no header/card seam
 * 2. Validated native TextField + stepped connection timeline
 * 3. Token-only colors; compact inset status row
 */
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, StyleSheet, View } from 'react-native';
import Animated, { Layout } from 'react-native-reanimated';

import { VersutusLogotype } from '@/components/brand';
import {
  CONNECTION_TIMELINE_STEPS_LONG,
  ConnectionTimeline,
} from '@/components/connection-timeline';
import { Button, Card, Screen, Text, TextField } from '@/components/ui';
import { Motion, Radius, Spacing } from '@/constants/tokens';
import { phaseToTimelineStep } from '@/lib/connection/phase';
import { validatePcAddress } from '@/lib/onboarding/validate-pc-address';
import { entering } from '@/lib/motion/presets';
import { useGateway } from '@/context/gateway-provider';
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
  const fieldState = !pcAddress.trim() ? 'default' : validation.valid ? 'valid' : 'invalid';

  async function handleContinue() {
    if (!validation.valid) return;

    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setError(null);
    setWorking(true);
    try {
      const ok = await setupFromPcAddress(pcAddress, token);
      if (ok) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace('/(tabs)/chat');
      }
    } catch (err) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.keyboard}>
        <View style={styles.content}>
          <Card
            variant="hero"
            padding={Spacing.four}
            style={[styles.unified, { borderColor: tokens.borderStrong, borderRadius: Radius.xl }]}>
            <View style={styles.brandBlock}>
              <VersutusLogotype tagline="Your OpenClaw gateway, always within reach over Tailscale." />
              <View style={[styles.rule, { backgroundColor: tokens.accentWarmMuted }]} />
            </View>

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
                validationState={fieldState}
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
                style={[
                  styles.statusCard,
                  {
                    backgroundColor: tokens.backgroundInset,
                    borderColor: tokens.glassBorder,
                  },
                ]}>
                {busy ? <ActivityIndicator color={tokens.accent} /> : null}
                <Text color="secondary">{probeMessage}</Text>
              </Animated.View>
            ) : null}

            {error ? (
              <View style={[styles.errorCard, { backgroundColor: tokens.accentWarmMuted, borderColor: tokens.accentWarm }]}>
                <Text color="accentWarm" variant="caption">
                  Cause: {error}
                </Text>
                <Text color="secondary" variant="caption">
                  Next: Check the address and setup token, then try again.
                </Text>
              </View>
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
  unified: {
    gap: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
  },
  brandBlock: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingBottom: Spacing.one,
  },
  rule: {
    height: 2,
    width: 48,
    borderRadius: 1,
    marginTop: Spacing.one,
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
    borderWidth: StyleSheet.hairlineWidth,
  },
  errorCard: {
    gap: Spacing.one,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  footnote: {
    lineHeight: 20,
    textAlign: 'center',
  },
});