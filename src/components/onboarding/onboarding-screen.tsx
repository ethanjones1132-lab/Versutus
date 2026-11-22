import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { Layout } from 'react-native-reanimated';

import { VersutusLogotype } from '@/components/brand';
import { PairingPanel } from '@/components/pairing-panel';
import { Button, Card, ErrorCard, Screen, Text, TextField } from '@/components/ui';
import { Motion, Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import { entering } from '@/lib/motion/presets';
import { onboardingKeyboardBehavior } from '@/lib/onboarding/keyboard-behavior';
import { deriveWizardCta } from '@/lib/onboarding/wizard-cta';
import { validatePcAddress } from '@/lib/onboarding/validate-pc-address';
import { currentWebOrigin, webGateStartCommand, webUnreachableCopy } from '@/lib/gateway/web-origin';
import { haptics } from '@/lib/haptics';

const GATE_START_COMMAND = 'node gate/cli.mjs start --host 100.x.y.z';
const GATE_SERVICE_COMMAND = 'node gate/cli.mjs service install --host 100.x.y.z';
const GATE_LAN_COMMAND = 'node gate/cli.mjs start --host 0.0.0.0 --allow-plaintext';
const GATE_DEPENDENCIES_COMMAND = 'npm install';
const GATE_SETUP_URL = 'https://github.com/ethanjones1132-lab/Versutus#versutus-gate';

function isTailscaleAddress(value: string): boolean {
  const host = value.trim().replace(/^[a-z]+:\/\//i, '').split(/[/:]/, 1)[0].toLowerCase();
  if (host.endsWith('.ts.net')) return true;
  const octets = host.split('.').map(Number);
  return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

export function OnboardingScreen() {
  const router = useRouter();
  const tokens = useTokens();
  const {
    setupFromPcAddress,
    probeMessage,
    connectionPhase,
    settings,
    retryAutoConnect,
    deviceId,
    pairingDetails,
    pendingGatewayAddressUpdate,
    acceptGatewayAddressUpdate,
  } = useGateway();
  const [pcAddress, setPcAddress] = useState(settings.tailscaleHost ?? '');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [manualAttempted, setManualAttempted] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [showGateSetup, setShowGateSetup] = useState(false);
  const isWeb = Platform.OS === 'web';
  
  const getStartCommand = () => {
    if (!isWeb) return GATE_START_COMMAND;
    // The web build is cross-origin to the Gate, so the command has to carry
    // this page's exact origin; the Gate opts that one origin in and nothing
    // else. `getStartCommand` never rewrites it into a wildcard.
    return webGateStartCommand(currentWebOrigin());
  };
  const [pairingPending, setPairingPending] = useState(false);
  const [tailscaleOffline, setTailscaleOffline] = useState(false);
  const connectingRef = useRef(false);
  const [retrying, setRetrying] = useState(false);
  // The cycle in flight, in a ref rather than in the state above: two taps
  // inside one frame come off the same rendered closure, where `setRetrying`
  // has not landed yet, and the second tap would start a second ladder.
  const retryingRef = useRef(false);
  // The retry is judged in an effect, not off the closure the tap was holding:
  // `connectionPhase` is only committed by a later render, so reading it where
  // `await retryAutoConnect()` returns reads the phase from BEFORE the tap.
  const [awaitingRetryPhase, setAwaitingRetryPhase] = useState(false);
  // A retry that succeeds lands the operator in the app exactly once. The
  // verdict is judged in an effect, and an effect can be judged again while the
  // phase lags the state that scheduled it (and StrictMode runs every effect
  // twice), so the landing needs its own latch the way the cycle has one —
  // otherwise a second `replace` would put a second chat entry on the stack.
  const retryLandedRef = useRef(false);
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
  // The manual Connect CTA stays available during background probes. Only this
  // form's own submit locks it, so a saved-address retry cannot block a new
  // address from being entered.
  const cta = deriveWizardCta(working, connectionPhase);
  const checking = working || retrying;
  const fieldState = !pcAddress.trim() ? 'default' : validation.valid ? 'valid' : 'invalid';

  async function copyCommand(key: string, command: string) {
    setCopyError(null);
    try {
      await Clipboard.setStringAsync(command);
      setCopiedCommand(key);
    } catch {
      setCopiedCommand(null);
      setCopyError('Couldn’t copy the command. Select it to copy it.');
    }
  }

  async function handleContinue() {
    if (!validation.valid || connectingRef.current) return;
    connectingRef.current = true;
    setManualAttempted(true);

    try {
      void Promise.resolve().then(() => haptics.medium()).catch(() => undefined);
      setError(null);
      setWorking(true);
      const result = await setupFromPcAddress(pcAddress, token);
      if (result.kind === 'connected') {
        void Promise.resolve().then(() => haptics.success()).catch(() => undefined);
        router.replace('/(tabs)/chat');
      } else if (result.kind === 'pending-approval') {
        setPairingPending(true);
      } else if (result.kind === 'new-address') {
        setError(null);
      } else if (result.kind === 'tls-fingerprint-change') {
        setError(
          `TLS fingerprint changed for ${result.gatewayName}. Review the new fingerprint before continuing.`,
        );
      } else if (result.kind === 'unreachable') {
        // Tailscale exists on the native app; a browser fetch that the Gate's
        // origin allow-list denied is indistinguishable from any other failed
        // fetch, so the web copy names the exact origin to allow instead of
        // sending the operator to turn on Tailscale.
        const tailnet = !isWeb && !result.message && isTailscaleAddress(pcAddress);
        setTailscaleOffline(tailnet);
        if (result.message) {
          setError(result.message);
        } else if (isWeb) {
          setError(webUnreachableCopy(currentWebOrigin()));
        } else if (tailnet) {
          setError('Turn on Tailscale on this phone, then try again.');
        } else {
          setError('Could not reach the gateway. Check its address and network, then try again.');
        }
      } else {
        setError(
          'The gateway responded, but the connection did not complete. Check its API key and try again.',
        );
      }
    } catch (err) {
      void Promise.resolve().then(() => haptics.error()).catch(() => undefined);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      connectingRef.current = false;
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
    retryLandedRef.current = false;
    setRetrying(true);
    setAwaitingRetryPhase(false);
    // The last retry's verdict is about the last retry; leaving its card up
    // over a fresh one would be misleading.
      setError(null);
      setTailscaleOffline(false);
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
        // reading it where the await returns would read the wrong one. Both
        // outcomes are read there — `failed` names itself, `connected` lands.
        setAwaitingRetryPhase(true);
      }
    }
  }

  useEffect(() => {
    if (!awaitingRetryPhase) return;
    // A retry that succeeds IS a connect, so it has to take the operator into
    // the app the way the Connect CTA does. Without this the probe ladder
    // recovers the connection and the operator is left on a screen whose only
    // remaining answer is the failure it has already shown them.
    if (connectionPhase === 'connected') {
      // Cleared before the landing: the verdict has been acted on, so a later
      // mount starts clean and cannot re-navigate from a stale retry.
      setAwaitingRetryPhase(false);
      if (retryLandedRef.current) return;
      retryLandedRef.current = true;
      void haptics.success();
      router.replace('/(tabs)/chat');
      return;
    }
    // A cycle that ends in `failed` again names itself in the error card — the
    // probe message still carries the words from BEFORE the tap.
    if (connectionPhase !== 'failed') return;
    setAwaitingRetryPhase(false);
    setError(
      (current) =>
        current ??
        probeMessage ??
        'The gateway could not be reached. Check its address and network, then try again.',
    );
  }, [awaitingRetryPhase, connectionPhase, probeMessage, router]);

  useEffect(() => {
    if (pairingPending && connectionPhase === 'connected') {
      setPairingPending(false);
      router.replace('/(tabs)/chat');
    }
  }, [connectionPhase, pairingPending, router]);

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
                <VersutusLogotype tagline="Your agents, on your own machine." />
              </Animated.View>
              <View style={[styles.rule, { backgroundColor: tokens.accentMuted }]} />
              <Text variant="eyebrow" color="tertiary" style={styles.eyebrow}>
                {checking ? 'CHECKING YOUR GATEWAY' : 'CONNECT YOUR PC'}
              </Text>

              <View style={styles.introStatus}>
                {checking ? (
                  <View style={styles.statusMessage}>
                    <ActivityIndicator size="small" color={tokens.accent} />
                    <Text variant="caption" color="secondary" numberOfLines={2} style={styles.statusText}>
                      {probeMessage ?? 'Checking your gateway…'}
                    </Text>
                  </View>
                ) : (
                  <View style={styles.statusMessage}>
                    <Text variant="caption" color="secondary" style={styles.statusText}>
                      Enter your PC&rsquo;s Tailscale name, IP, or local address below.
                    </Text>
                  </View>
                )}
              </View>
            </Card>
          </Animated.View>

          <Card variant="surface" padding={Spacing.four} style={[styles.formCard, cta.locked && styles.formDimmed]}>
            <Text variant="title">Connect to your PC</Text>
            <Text color="secondary" style={styles.lead}>
              Enter your PC&rsquo;s address. Paste its gateway key, or leave it blank and approve this phone on the PC.
            </Text>

            <View style={styles.field}>
              <Text variant="caption" color="secondary">
                PC address
              </Text>
              <TextField
                value={pcAddress}
                onChangeText={setPcAddress}
                placeholder="my-pc.tailnet.ts.net"
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
                Gateway key
              </Text>
              <TextField
                value={token}
                onChangeText={setToken}
                placeholder="Paste your gateway key"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
              <Text variant="micro" color="tertiary">
                Leave blank to pair instead: you&rsquo;ll approve this phone on your PC.
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
                Enter a full gateway address
              </Text>
            </Pressable>

            {probeMessage && !checking ? (
              <Animated.View
                layout={Layout.duration(Motion.duration.normal)}
                entering={entering.fadeIn}
                exiting={entering.fadeOut}
                style={[styles.statusCard, { backgroundColor: tokens.backgroundInset, borderColor: tokens.borderSubtle }]}>
                {checking ? <ActivityIndicator color={tokens.accent} /> : null}
                <Text color="secondary">{probeMessage}</Text>
              </Animated.View>
            ) : null}

            {probeMessage && !manualAttempted && (retrying || (!checking && connectionPhase === 'failed')) ? (
              // Retry re-runs the auto-connect cycle, the
              // same affordance Home's Try-again button fires, and says so
              // while it is running instead of sitting there looking dead.
              // `retrying` carries the button through the whole cycle: the
              // ladder parks the phase in 'searching' before its first await,
              // and a phase-gated button would unmount the
              // instant it was tapped — taking its "Retrying…" label with it.
              // Other states keep the retry out of the way.
              <Button
                label={retrying ? 'Trying again…' : 'Try again'}
                onPress={() => void handleRetry()}
                disabled={retrying}
              />
            ) : null}

            {error ? (
              <ErrorCard
                cause={error}
                affected="Connection"
                next="Check the address and key, then try again."
                onRetry={() => void handleContinue()}
                retryLabel="Try again"
              />
            ) : null}
            {error && tailscaleOffline ? (
              <Pressable
                onPress={() => void Linking.openURL('tailscale://').catch(() => undefined)}
                accessibilityRole="link"
                accessibilityLabel="Open Tailscale">
                <Text variant="link" color="accent">Open Tailscale</Text>
              </Pressable>
            ) : null}

            {pendingGatewayAddressUpdate ? (
              <Button
                label="Use the new address"
                accessibilityHint={`Update ${pendingGatewayAddressUpdate.gatewayName} to ${pendingGatewayAddressUpdate.address}`}
                onPress={() => void acceptGatewayAddressUpdate?.()}
                disabled={!acceptGatewayAddressUpdate}
              />
            ) : (
                <Button
                  label={cta.label}
                  onPress={() => void handleContinue()}
                  disabled={cta.locked || !validation.valid}
                />
            )}
            {pairingPending ? (
              deviceId ? (
                <PairingPanel deviceId={deviceId} pairingDetails={pairingDetails} />
              ) : (
                <Text variant="headline">
                  On your PC, open http://localhost:8760/pair and click Approve.
                </Text>
              )
            ) : null}
          </Card>

          <Card variant="surface" padding={Spacing.three} style={styles.gateGuide}>
            <Pressable
              onPress={() => setShowGateSetup((visible) => !visible)}
              accessibilityRole="button"
              accessibilityLabel="Set up the Gate"
              accessibilityState={{ expanded: showGateSetup }}
              aria-expanded={showGateSetup}
              style={styles.guideToggle}>
              <View>
                <Text variant="headline">Set up the Gate</Text>
                <Text variant="caption" color="secondary">Need the Gate on your PC?</Text>
              </View>
              <Text variant="caption" color="accent">{showGateSetup ? 'Hide' : 'Show'}</Text>
            </Pressable>
            {showGateSetup ? (
              <View style={styles.guideDetails}>
                <Text variant="caption" color="secondary">
                  On your PC, open the Versutus checkout. The README has the full Gate setup guide:
                </Text>
                <Pressable
                  onPress={() =>
                    void Linking.openURL(GATE_SETUP_URL).catch(() =>
                      setCopyError('Couldn’t open the guide. Visit github.com/ethanjones1132-lab/Versutus.'),
                    )
                  }
                  accessibilityRole="link"
                  accessibilityLabel="Open the Versutus Gate setup guide">
                  <Text variant="link" color="accent">Open the Gate setup guide</Text>
                </Pressable>
                <Text variant="caption" color="secondary">
                  {isWeb
                    ? 'From the checkout root, install dependencies once, then start the Gate with the allow-origin command below. Enter the address this browser uses above.'
                    : 'From the checkout root, install dependencies once, then start the Gate with your PC&rsquo;s Tailscale IP. Enter the same IP above.'}
                </Text>
                <CommandRow
                  label="Install dependencies"
                  command={GATE_DEPENDENCIES_COMMAND}
                  copied={copiedCommand === 'dependencies'}
                  borderColor={tokens.borderSubtle}
                  onCopy={() => void copyCommand('dependencies', GATE_DEPENDENCIES_COMMAND)}
                />
                <CommandRow
                  label="Start now"
                  command={getStartCommand()}
                  copied={copiedCommand === 'start'}
                  borderColor={tokens.borderSubtle}
                  onCopy={() => void copyCommand('start', getStartCommand())}
                />
                <Text variant="micro" color="tertiary">
                  Optional on Windows or macOS: install the Gate as a service so it starts after sign-in.
                </Text>
                <CommandRow
                  label="Install as a service"
                  command={GATE_SERVICE_COMMAND}
                  copied={copiedCommand === 'service'}
                  borderColor={tokens.borderSubtle}
                  onCopy={() => void copyCommand('service', GATE_SERVICE_COMMAND)}
                />
                <Text variant="micro" color="tertiary">
                  Optional LAN access: listens on every PC interface and sends gateway keys without encryption. Use only on a trusted network with a firewall:
                </Text>
                <CommandRow
                  label="Copy LAN command"
                  command={GATE_LAN_COMMAND}
                  copied={copiedCommand === 'lan'}
                  borderColor={tokens.borderSubtle}
                  onCopy={() => void copyCommand('lan', GATE_LAN_COMMAND)}
                />
                {copyError ? <Text variant="caption" color="statusDisconnected">{copyError}</Text> : null}
                <Text variant="micro" color="tertiary">
                  After connecting, send a short message. If Chat has no model, open Gate setup to add a provider or connect a command-line tool.
                </Text>
              </View>
            ) : null}
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function CommandRow({
  label,
  command,
  copied,
  borderColor,
  onCopy,
}: {
  label: string;
  command: string;
  copied: boolean;
  borderColor: string;
  onCopy: () => void;
}) {
  return (
    <Pressable
      onPress={onCopy}
      accessibilityRole="button"
      accessibilityLabel={`${copied ? 'Copied' : 'Copy'} ${label.toLowerCase()}`}
      style={[styles.commandRow, { borderColor }]}>
      <View style={styles.commandTextWrap}>
        <Text variant="micro" color="tertiary">{label}</Text>
        <Text variant="mono" numberOfLines={2} style={styles.commandText}>{command}</Text>
      </View>
      <Text variant="caption" color={copied ? 'accent' : 'tertiary'}>{copied ? 'Copied' : 'Copy'}</Text>
    </Pressable>
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
  introStatus: {
    alignSelf: 'stretch',
    paddingTop: Spacing.one,
  },
  statusMessage: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  statusText: {
    flex: 1,
    lineHeight: 16,
  },
  gateGuide: {
    gap: Spacing.two,
    borderRadius: Radius.lg,
  },
  guideToggle: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  guideDetails: {
    gap: Spacing.two,
  },
  commandRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  commandTextWrap: {
    flex: 1,
    gap: 2,
  },
  commandText: {
    flexShrink: 1,
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
  tailnetHelp: {
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
});
