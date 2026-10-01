import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  Layout,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { VersutusLogotype } from '@/components/brand';
import { ConnectionTimeline, CONNECTION_TIMELINE_STEPS_LONG } from '@/components/connection-timeline';
import { Button, Card, ErrorCard, Screen, Text, TextField } from '@/components/ui';
import { Motion, Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import { phaseToTimelineStep } from '@/lib/connection/phase';
import { entering } from '@/lib/motion/presets';
import { onboardingKeyboardBehavior } from '@/lib/onboarding/keyboard-behavior';
import { deriveWizardCta } from '@/lib/onboarding/wizard-cta';
import { validatePcAddress } from '@/lib/onboarding/validate-pc-address';
import { haptics } from '@/lib/haptics';

export function OnboardingScreen() {
  const router = useRouter();
  const tokens = useTokens();
  const { setupFromPcAddress, probeMessage, connectionPhase, settings, retryAutoConnect } = useGateway();
  const [pcAddress, setPcAddress] = useState(settings.tailscaleHost ?? '');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // The cycle in flight, in a ref rather than in the state above: two taps
  // inside one frame come off the same rendered closure, where `setRetrying`
  // has not landed yet, and the second tap would start a second ladder.
  const retryingRef = useRef(false);
  // The retry is judged in an effect, not off the closure the tap was holding:
  // `connectionPhase` is only committed by a later render, so reading it where
  // `await retryAutoConnect()` returns reads the phase from BEFORE the tap.
  const [awaitingRetryPhase, setAwaitingRetryPhase] = useState(false);
  // `setRetrying` after the screen is gone is a setState on a dead tree, so the
  // cycle's own cleanup says whether this screen is still the one waiting.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const validation = useMemo(() => validatePcAddress(pcAddress), [pcAddress]);
  // The manual Connect CTA must stay reachable while the background
  // auto-connect ceremony parks the phase in 'searching' for 30–60 s probe
  // rounds (retry ladder re-fires them), or the typed manual connect becomes
  // unreachable for minutes on a machine where discovery only gets 403s.
  // `locked` follows only this form's own submit; the scan theater keeps
  // animating for any probe/connect in flight (matrix §G finding 2).
  const cta = deriveWizardCta(working, connectionPhase);
  const busy = cta.theaterBusy;
  const activeTimelineStep = phaseToTimelineStep(connectionPhase);
  const fieldState = !pcAddress.trim() ? 'default' : validation.valid ? 'valid' : 'invalid';

  async function handleContinue() {
    if (!validation.valid) return;

    await haptics.medium();
    setError(null);
    setWorking(true);
    try {
      const result = await setupFromPcAddress(pcAddress, token);
      if (result.kind === 'connected') {
        await haptics.success();
        router.replace('/(tabs)/chat');
      } else if (result.kind === 'tls-fingerprint-change') {
        setError(
          `TLS fingerprint changed for ${result.gatewayName}. Review the new fingerprint before continuing.`,
        );
      } else if (result.kind === 'unreachable') {
        setError('Could not reach the gateway. Check its address and network, then try again.');
      } else {
        setError(
          'The gateway responded, but the connection did not complete. Check its API key and try again.',
        );
      }
    } catch (err) {
      await haptics.error();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  /**
   * The failed auto-connect's Retry. It has to hold the button honest while the
   * ladder runs and name the outcome when the ladder ends in `failed` again —
   * the probe message alone cannot, because it still carries the words from
   * BEFORE the tap.
   */
  async function handleRetry() {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    setAwaitingRetryPhase(false);
    // The last retry's verdict is about the last retry; leaving its card up
    // over a fresh one would be the same lie the busy state is fixing.
    setError(null);
    try {
      await retryAutoConnect();
    } catch (err) {
      // `retryAutoConnect` reports through the provider rather than rejecting,
      // so this is the belt to that braces: whatever does throw must be named
      // here, not left for the `void` on the press to drop.
      if (mountedRef.current) {
        setError((current) => current ?? (err instanceof Error ? err.message : String(err)));
      }
    } finally {
      retryingRef.current = false;
      if (mountedRef.current) {
        setRetrying(false);
        // The verdict is judged where the phase is committed: the render this
        // tap triggers still carries the phase from BEFORE the ladder ran, so
        // reading it where the await returns would read the wrong one.
        setAwaitingRetryPhase(true);
      }
    }
  }

  useEffect(() => {
    if (!awaitingRetryPhase) return;
    if (connectionPhase !== 'failed') return;
    setAwaitingRetryPhase(false);
    setError(
      (current) =>
        current ??
        probeMessage ??
        'The gateway could not be reached. Check its address and network, then try again.',
    );
  }, [awaitingRetryPhase, connectionPhase, probeMessage]);

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.keyboard} behavior={onboardingKeyboardBehavior(Platform.OS)}>
        {/* Scrollable, not a centered fixed block: the error card and probe
            status grow this content past the viewport, and a centered overflow
            pushes the connect button and the error's own retry off both edges
            with no way to reach them. flexGrow keeps it centered when short. */}
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}>
          <Animated.View entering={entering.fadeIn}>
            <Card variant="hero" padding={Spacing.four} style={styles.hero}>
              <Animated.View entering={entering.fadeIn.delay(80)}>
                <VersutusLogotype tagline="A precise mobile console for your AI gateway." />
              </Animated.View>
              <View style={[styles.rule, { backgroundColor: tokens.accentMuted }]} />
              <Text variant="eyebrow" color="tertiary" style={styles.eyebrow}>
                {busy ? 'DISCOVERING YOUR GATEWAY · 02' : 'FIRST CONNECTION · 01'}
              </Text>

              <View style={styles.scanSection}>
                <ScanningStrip active={busy} color={tokens.accent} track={tokens.border} />
                <ConnectionTimeline
                  activeStep={activeTimelineStep}
                  busy={busy}
                  steps={CONNECTION_TIMELINE_STEPS_LONG}
                />
                {busy ? (
                  <View style={styles.scanMessage}>
                    <ActivityIndicator size="small" color={tokens.accent} />
                    <Text variant="caption" color="secondary" numberOfLines={2} style={styles.scanText}>
                      {probeMessage ?? 'Scanning Tailscale, local discovery, and saved profiles in order…'}
                    </Text>
                  </View>
                ) : (
                  <View style={styles.scanMessage}>
                    <Text variant="caption" color="tertiary" numberOfLines={2} style={styles.scanText}>
                      Enter your PC or gateway address below, or let Versutus find it on your tailnet.
                    </Text>
                  </View>
                )}
              </View>
            </Card>
          </Animated.View>

          <Card variant="surface" padding={Spacing.four} style={[styles.formCard, cta.locked && styles.formDimmed]}>
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

            {/* A scheme URL (ws://, http://) fails the hostname/IP gate above
                on purpose — the manual add sheet accepts and canonicalizes
                full URLs, and /gateway/add is exempt from the onboarding
                redirect (route-guard), so this is the one path in for an
                OpenClaw or custom-URL first run. */}
            <Pressable
              onPress={() => router.push('/gateway/add')}
              accessibilityRole="button"
              accessibilityLabel="Add a custom gateway URL">
              <Text variant="link" color="accent">
                Using a custom URL (ws:// or http://)? Add it manually
              </Text>
            </Pressable>

            {probeMessage && !busy ? (
              <Animated.View
                layout={Layout.duration(Motion.duration.normal)}
                entering={entering.fadeIn}
                exiting={entering.fadeOut}
                style={[styles.statusCard, { backgroundColor: tokens.backgroundInset, borderColor: tokens.borderSubtle }]}>
                {busy ? <ActivityIndicator color={tokens.accent} /> : null}
                <Text color="secondary">{probeMessage}</Text>
              </Animated.View>
            ) : null}

            {probeMessage && (retrying || (!busy && connectionPhase === 'failed')) ? (
              // The failed auto-connect message says "Tap retry", and the
              // Connect CTA above stays disabled until an address validates —
              // on a discovery-only failure the field is empty and there was
              // no tap anywhere. Retry re-runs the auto-connect cycle, the
              // same affordance Home's Try-again button fires, and says so
              // while it is running instead of sitting there looking dead.
              // `retrying` deliberately outranks `busy`: the ladder parks the
              // phase in 'searching' before its first await, so `busy` is true
              // for the whole cycle and a busy-gated button would unmount the
              // instant it was tapped — taking its "Retrying…" label with it.
              // Every other situation still hides on `busy` as before.
              <Button
                label={retrying ? 'Retrying…' : 'Retry'}
                onPress={() => void handleRetry()}
                disabled={retrying}
              />
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
              label={cta.label}
              onPress={() => void handleContinue()}
              disabled={cta.locked || !validation.valid}
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

/** Discovery-theater scan line: a violet pulse sweeping a thin track. */
function ScanningStrip({ active, color, track }: { active: boolean; color: string; track: string }) {
  const x = useSharedValue(-40);

  useEffect(() => {
    if (!active) {
      x.value = withTiming(-40, { duration: 200 });
      return;
    }
    x.value = withRepeat(
      withTiming(280, { duration: 1500, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
  }, [active, x]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }],
  }));

  return (
    <View style={[styles.scanTrack, { backgroundColor: track }]}>
      <Animated.View
        style={[styles.scanDot, { backgroundColor: color, opacity: active ? 0.9 : 0.35 }, animatedStyle]}
      />
    </View>
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
    flexShrink: 1,
  },
  scanSection: {
    alignSelf: 'stretch',
    gap: Spacing.three,
    paddingTop: Spacing.one,
  },
  scanTrack: {
    height: 2,
    borderRadius: 1,
    overflow: 'hidden',
  },
  scanDot: {
    width: 56,
    height: 2,
    borderRadius: 1,
  },
  scanMessage: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  scanText: {
    flex: 1,
    lineHeight: 16,
  },
  formDimmed: {
    opacity: 0.55,
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
