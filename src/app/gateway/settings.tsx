import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Link } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { DeviceIdRow } from '@/components/device-id-row';
import { NotificationsSection } from '@/components/gateway/notifications-section';
import { SpendEntryRow } from '@/components/gateway/spend-entry-row';
import { TransportSecurityCard } from '@/components/gateway/transport-security-card';
import { Badge, Card, ErrorCard, Icon, Screen, Skeleton, Text } from '@/components/ui';
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
import { pushDeviceParams } from '@/lib/notifications/push-registration';
import { deviceAppLockState } from '@/lib/settings/app-lock-device';
import {
  WIDGET_PRIVACY_LABEL,
  WIDGET_PRIVACY_SUMMARY,
  loadWidgetResultHidden,
  saveWidgetResultHidden,
} from '@/lib/settings/widget-privacy';
import { loadAppSettings, saveAppSettings } from '@/lib/settings/app-settings';
import {
  approvalAuditCopy,
  approvalAuditSummaryCopy,
  loadApprovalAudit,
  type ApprovalAuditEntry,
} from '@/lib/gateway/approval-policy';
import type { VoiceEngineCapabilities, VoiceEnginePreference } from '@/lib/voice/voice-engine-choice';
import {
  GROK_DISABLED_REASON,
  GROK_ROW_LABEL,
  VOICE_ENGINE_ROWS,
  voiceEngineReadinessCopy,
  voiceUsageCopy,
} from '@/lib/voice/voice-engine-copy';

/** The readiness sentence for one Settings row. */
function voiceReadiness(
  id: VoiceEnginePreference,
  capabilities: VoiceEngineCapabilities | null,
  state: 'checking' | 'ready' | 'failed',
  voiceCheckError: string | null,
): string {
  if (id === 'phone') return 'Always available on this phone.';
  // A refused read never masquerades as an in-progress one: name the
  // refusal (the inline catch comment's promise) instead of spinning on
  // "Checking this PC…" for the rest of the session.
  if (state === 'failed') {
    return voiceCheckError
      ? `Couldn't check this PC: ${voiceCheckError}`
      : "Couldn't check this PC's voice engines.";
  }
  if (id === 'auto') return 'Follows whichever engine below is ready.';
  if (!capabilities) return 'Checking this PC…';
  if (!capabilities.enabled) return 'Gate voice is turned off on this PC.';
  const status = capabilities.engines[id];
  return voiceEngineReadinessCopy(status?.state ?? 'unavailable', status?.reason);
}

export default function GatewaySettingsScreen() {
  const { activeGateway, settings, deviceId, deviceIdState, deviceIdError, reloadDeviceId, gatewayRequest } =
    useGateway();
  const tokens = useTokens();
  const [copied, setCopied] = useState<'id' | null>(null);
  const [appLock, setAppLock] = useState(false);
  const [appLockReason, setAppLockReason] = useState<AppLockUnavailableReason | null>(null);
  const [voiceEngine, setVoiceEngine] = useState<VoiceEnginePreference>(settings.voiceEngine);
  const [voiceCapabilities, setVoiceCapabilities] = useState<VoiceEngineCapabilities | null>(null);
  // Distinguish the first in-flight read from a refusal: null capabilities
  // alone can no longer mean both "still checking" and "the Gate said no".
  const [voiceCheckState, setVoiceCheckState] = useState<'checking' | 'ready' | 'failed'>('checking');
  const [voiceCheckError, setVoiceCheckError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installNote, setInstallNote] = useState<string | null>(null);
  // D1: this device's durable approval decisions (newest first). The loaded
  // gate keeps first paint from asserting the empty claim before the deferred
  // read lands (the lie Activity's card closed with auditState in iter-322).
  const [audit, setAudit] = useState<ApprovalAuditEntry[]>([]);
  const [auditLoaded, setAuditLoaded] = useState(false);
  const [hideWidgetResult, setHideWidgetResult] = useState(false);

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

  useEffect(() => {
    let cancelled = false;
    void loadWidgetResultHidden().then((hidden) => {
      if (!cancelled) setHideWidgetResult(hidden);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAppLock = useCallback((next: boolean) => {
    setAppLock(next);
    void saveAppLock(next);
  }, []);

  const readVoiceCapabilities = useCallback(async (): Promise<
    { ok: true; capabilities: VoiceEngineCapabilities } | { ok: false; error: string }
  > => {
    try {
      const capabilities = await gatewayRequest<VoiceEngineCapabilities>(
        'voice.capabilities',
        await pushDeviceParams(),
      );
      return { ok: true, capabilities };
    } catch (caught) {
      // Offline or a Gate that predates voice: the caller names the refusal
      // on the rows rather than leaving them on "Checking this PC…" forever.
      return { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
    }
  }, [gatewayRequest]);

  const applyVoiceRead = useCallback(
    (result: { ok: true; capabilities: VoiceEngineCapabilities } | { ok: false; error: string }) => {
      if (result.ok) {
        setVoiceCapabilities(result.capabilities);
        setVoiceCheckState('ready');
        setVoiceCheckError(null);
      } else {
        setVoiceCapabilities(null);
        setVoiceCheckState('failed');
        setVoiceCheckError(result.error);
      }
    },
    [],
  );

  const retryVoiceCapabilities = useCallback(() => {
    setVoiceCheckState('checking');
    setVoiceCheckError(null);
    void readVoiceCapabilities().then(applyVoiceRead);
  }, [readVoiceCapabilities, applyVoiceRead]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadAppSettings();
      if (!cancelled) setVoiceEngine(stored.voiceEngine);
      const result = await readVoiceCapabilities();
      if (!cancelled) applyVoiceRead(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [readVoiceCapabilities, applyVoiceRead]);

  useEffect(() => {
    let cancelled = false;
    void loadApprovalAudit().then((entries) => {
      if (cancelled) return;
      setAudit(entries);
      setAuditLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleVoiceEngine = useCallback((next: VoiceEnginePreference) => {
    setVoiceEngine(next);
    void saveAppSettings({ voiceEngine: next });
  }, []);

  // Install the PC voice models from the phone: start the Gate's install, then
  // watch its status until it leaves `installing` and refresh capabilities.
  const handleVoiceInstall = useCallback(async () => {
    setInstalling(true);
    setInstallNote('Downloading the PC voice models…');
    try {
      await gatewayRequest('voice.install.start', await pushDeviceParams());
    } catch {
      setInstalling(false);
      setInstallNote('The Gate could not start the install.');
      return;
    }
    for (let attempt = 0; attempt < 900; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      let status: { state?: string; reason?: string } | null = null;
      try {
        status = await gatewayRequest<{ state?: string; reason?: string }>('voice.install.status', await pushDeviceParams());
      } catch {
        break;
      }
      setInstallNote(status?.reason ?? null);
      if (status?.state !== 'installing') break;
    }
    try {
      const read = await gatewayRequest<VoiceEngineCapabilities>('voice.capabilities', await pushDeviceParams());
      setVoiceCapabilities(read);
    } catch {
      // keep the last known capabilities
    }
    setInstalling(false);
  }, [gatewayRequest]);

  const handleWidgetPrivacy = useCallback((next: boolean) => {
    setHideWidgetResult(next);
    void saveWidgetResultHidden(next);
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
          <View style={styles.sectionHeading}>
            <View style={styles.sectionTitle}>
              <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
                Home screen
              </Text>
              <Text variant="headline">{WIDGET_PRIVACY_LABEL}</Text>
            </View>
          </View>
          <Text color="secondary">{WIDGET_PRIVACY_SUMMARY}</Text>
          <Switch
            value={hideWidgetResult}
            onValueChange={handleWidgetPrivacy}
            trackColor={{ true: tokens.accent, false: tokens.border }}
            thumbColor={tokens.textPrimary}
            accessibilityLabel={WIDGET_PRIVACY_LABEL}
            accessibilityState={{ checked: hideWidgetResult }}
          />
        </Card>

        <Card variant="surface" padding={Spacing.three} style={styles.card}>
          <View style={styles.sectionHeading}>
            <View style={styles.sectionTitle}>
              <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
                Voice
              </Text>
              <Text variant="headline">Power hands-free with</Text>
            </View>
          </View>
          <Text color="secondary">
            Where a call&apos;s audio goes, and which machine runs the speech models.
          </Text>
          {voiceCheckState === 'failed' ? (
            <ErrorCard
              cause={voiceCheckError ?? "The Gate did not answer this PC's voice check."}
              affected="Voice engine readiness on this PC"
              next="Retry — the rows below only reflect the Gate after a successful read."
              onRetry={retryVoiceCapabilities}
            />
          ) : null}
          {VOICE_ENGINE_ROWS.map((row) => {
            const selected = voiceEngine === row.id;
            return (
              <Pressable
                key={row.id}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={`${row.label}. ${row.summary}`}
                onPress={() => handleVoiceEngine(row.id)}
                style={[styles.voiceRow, selected ? { borderColor: tokens.accent } : null]}>
                <View style={styles.sectionTitle}>
                  <Text variant="caption" color={selected ? 'accent' : 'primary'}>
                    {row.label}
                  </Text>
                  <Text variant="micro" color="tertiary">
                    {row.summary}
                  </Text>
                  <Text variant="micro" color="tertiary">
                    {voiceReadiness(row.id, voiceCapabilities, voiceCheckState, voiceCheckError)}
                  </Text>
                </View>
                {selected ? <Badge label="Using" tone="success" dot={false} /> : null}
              </Pressable>
            );
          })}
          <View style={[styles.voiceRow, styles.voiceRowDisabled]}>
            <View style={styles.sectionTitle}>
              <Text variant="caption" color="tertiary">
                {GROK_ROW_LABEL}
              </Text>
              <Text variant="micro" color="tertiary">
                {GROK_DISABLED_REASON}
              </Text>
            </View>
            <Badge label="Disabled" tone="warning" dot={false} />
          </View>
          <View style={styles.voiceRow}>
            <View style={styles.sectionTitle}>
              <Text variant="caption" color="tertiary">
                Today
              </Text>
              <Text variant="micro" color="tertiary">
                {voiceUsageCopy(voiceCapabilities?.usedToday, voiceCapabilities?.lastError)}
              </Text>
            </View>
          </View>
          {installing ? (
            <View style={styles.voiceRow}>
              <View style={styles.sectionTitle}>
                <Text variant="caption" color="accent">
                  Installing on this PC…
                </Text>
                <Text variant="micro" color="tertiary">
                  {installNote ?? 'This can take a few minutes.'}
                </Text>
              </View>
            </View>
          ) : voiceCapabilities?.engines.local?.state === 'not-installed' || installNote ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Install on this PC"
              onPress={handleVoiceInstall}
              style={styles.voiceRow}>
              <View style={styles.sectionTitle}>
                <Text variant="caption" color="accent">
                  Install on this PC (≈2 GB download)
                </Text>
                <Text variant="micro" color="tertiary">
                  {installNote ?? 'Downloads the speech models to the Gate PC.'}
                </Text>
              </View>
            </Pressable>
          ) : null}
        </Card>

        <NotificationsSection />

        <Card variant="surface" padding={Spacing.three} style={styles.card}>
          <View style={styles.sectionHeading}>
            <View style={styles.sectionTitle}>
              <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
                Approvals
              </Text>
              <Text variant="headline">Decision history</Text>
            </View>
            {auditLoaded ? (
              <Badge
                label={String(audit.length)}
                tone={audit.length > 0 ? 'accent' : 'neutral'}
                dot={false}
              />
            ) : null}
          </View>
          {!auditLoaded ? (
            <>
              <Skeleton width="72%" height={14} />
              <Skeleton width="90%" height={12} />
              <Skeleton width="64%" height={12} />
            </>
          ) : (
            <>
              <Text color="secondary">{approvalAuditSummaryCopy(audit.length)}</Text>
              {audit.slice(0, 5).map((record) => (
                <Text key={`${record.approvalId}-${record.at}`} variant="caption" color="tertiary">
                  {approvalAuditCopy(record)}
                </Text>
              ))}
            </>
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
              ) : deviceIdState === 'failed' ? (
                <ErrorCard
                  cause={deviceIdError ?? 'This phone could not make its device identity.'}
                  affected="this device's identity for pairing and access requests"
                  next="Retry — pairing and access requests name this phone by that identity."
                  onRetry={reloadDeviceId}
                />
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
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    padding: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
  voiceRowDisabled: {
    opacity: 0.6,
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
