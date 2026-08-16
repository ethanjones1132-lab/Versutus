import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { Layout } from 'react-native-reanimated';

import { VersutusLogotype } from '@/components/brand';
import { ConnectionTimeline, CONNECTION_TIMELINE_STEPS_LONG } from '@/components/connection-timeline';
import { Button, Card, ErrorCard, Screen, Text, TextField } from '@/components/ui';
import { Motion, Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import { phaseToTimelineStep } from '@/lib/connection/phase';
import { entering } from '@/lib/motion/presets';
import { validatePcAddress } from '@/lib/onboarding/validate-pc-address';

export function OnboardingScreen() {
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
      <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        {/* Scrollable, not a centered fixed block: the error card and probe
            status grow this content past the viewport, and a centered overflow
            pushes the connect button and the error's own retry off both edges
            with no way to reach them. flexGrow keeps it centered when short. */}
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}>
          <Card variant="hero" padding={Spacing.four} style={styles.hero}>
            <VersutusLogotype tagline="A precise mobile console for your AI gateway." />
            <View style={[styles.rule, { backgroundColor: tokens.accentWarmMuted }]} />
            <Text variant="micro" color="accentWarm" style={styles.eyebrow}>
              FIRST CONNECTION · 01
            </Text>
          </Card>

          <Card variant="surface" padding={Spacing.four} style={styles.formCard}>
            <Text variant="title">Connect your gateway</Text>
            <Text color="secondary" style={styles.lead}>
              Give Versutus the address and API key for the gateway running on your PC. Your credentials are stored in
              secure device storage.
            </Text>

            <View style={styles.field}>
              <Text variant="caption" color="secondary">
                PC or gateway address
              </Text>
              <TextField
                value={pcAddress}
                onChangeText={setPcAddress}
                placeholder="ethanspc.tail3a1a8a.ts.net"
                autoCapitalize="none"
                autoCorrect={false}
                validationState={fieldState}
              />
              <Text
                variant="caption"
                color={
                  fieldState === 'valid'
                    ? 'statusConnected'
                    : fieldState === 'invalid'
                      ? 'statusDisconnected'
                      : 'secondary'
                }>
                {validation.message}
              </Text>
            </View>

            <View style={styles.field}>
              <Text variant="caption" color="secondary">
                Gateway API key
              </Text>
              <TextField
                value={token}
                onChangeText={setToken}
                placeholder="Paste API_SERVER_KEY"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
              <Text variant="micro" color="tertiary">
                Optional when the gateway is configured without authentication.
              </Text>
            </View>

            <ConnectionTimeline activeStep={activeTimelineStep} busy={busy} steps={CONNECTION_TIMELINE_STEPS_LONG} />

            {probeMessage ? (
              <Animated.View
                layout={Layout.duration(Motion.duration.normal)}
                entering={entering.fadeIn}
                exiting={entering.fadeOut}
                style={[styles.statusCard, { backgroundColor: tokens.backgroundInset, borderColor: tokens.borderSubtle }]}>
                {busy ? <ActivityIndicator color={tokens.accent} /> : null}
                <Text color="secondary">{probeMessage}</Text>
              </Animated.View>
            ) : null}

            {error ? (
              <ErrorCard
                cause={error}
                affected="gateway connection"
                next="Check the address and API key, then try again."
                onRetry={() => void handleContinue()}
                retryLabel="Try again"
              />
            ) : null}

            <Button
              label={busy ? 'Connecting…' : 'Connect gateway'}
              onPress={() => void handleContinue()}
              disabled={busy || !validation.valid}
            />
          </Card>

          <Text color="tertiary" variant="caption" style={styles.footnote}>
            Versutus tries secure Tailscale, local discovery, and saved gateway profiles in order. You approve this
            device only when the gateway asks for it.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  keyboard: {
    flex: 1,
  },
  content: {
    // flexGrow, not flex: centers a short form, but lets a tall one scroll
    // instead of overflowing off-screen.
    flexGrow: 1,
    padding: Spacing.four,
    paddingBottom: Spacing.six,
    gap: Spacing.three,
    justifyContent: 'center',
  },
  hero: {
    alignItems: 'center',
    borderRadius: Radius.xl,
    gap: Spacing.two,
  },
  rule: {
    height: 2,
    width: 48,
    borderRadius: 1,
  },
  eyebrow: {
    textTransform: 'uppercase',
    letterSpacing: 0.8,
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
    borderWidth: StyleSheet.hairlineWidth,
  },
  footnote: {
    lineHeight: 20,
    textAlign: 'center',
  },
});
