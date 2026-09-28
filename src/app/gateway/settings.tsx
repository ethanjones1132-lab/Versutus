import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Link } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { DeviceIdRow } from '@/components/device-id-row';
import { NotificationsSection } from '@/components/gateway/notifications-section';
import { SpendEntryRow } from '@/components/gateway/spend-entry-row';
import { TransportSecurityCard } from '@/components/gateway/transport-security-card';
import { VersutusMark } from '@/components/brand/versutus-mark';
import {
  Badge,
  Card,
  ErrorCard,
  Icon,
  RowGroup,
  RowGroupRow,
  Screen,
  SectionHeader,
  Skeleton,
  Text,
} from '@/components/ui';
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
  const {
    activeGateway,
    settings,
    status,
    deviceId,
    deviceIdState,
    deviceIdError,
    reloadDeviceId,
    gatewayRequest,
  } = useGateway();
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
      // The refresh after an install publishes the SAME read state as the
      // first read, so a Gate that once refused does not stay "failed" while
      // freshly readable rows sit beneath the error card.
      applyVoiceRead({ ok: true, capabilities: read });
    } catch {
      // keep the last known capabilities
    }
    setInstalling(false);
  }, [gatewayRequest, applyVoiceRead]);

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

  const gateName = settings.pcName ?? activeGateway?.name ?? 'No gateway yet';
  // The Today line reads the same read state the rows do: an in-flight or
  // refused read measured nothing and may not print a measured zero.
  const voiceUsageReadState =
    voiceCheckState === 'checking' ? 'loading' : voiceCheckState === 'failed' ? 'error' : 'ready';

  return (
    <Screen edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Who this app is talking to, set like the top of an account page:
            the mark, the Gate's name in the serif, and one status line. */}
        <View style={styles.identity}>
          <VersutusMark size={56} />
          <View style={styles.identityText}>
            <Text variant="title" numberOfLines={1} style={styles.identityName}>
              {gateName}
            </Text>
            <View style={styles.identityStatus}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: status === 'connected' ? tokens.statusConnected : tokens.textTertiary },
                ]}
              />
              <Text variant="caption" color="secondary" numberOfLines={1}>
                {status === 'connected' ? 'Connected' : 'Not connected'}
                {activeGateway?.kind ? ` · ${activeGateway.kind === 'hermes' ? 'Hermes Gate' : activeGateway.kind}` : ''}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeader title="Gate" />
          <RowGroup>
            <Link href="/gateway/setup" asChild>
              <RowGroupRow
                title="Providers & gateways"
                subtitle="Providers, environments, saved gateways"
                icon={{ ios: 'server.rack', android: 'dns', web: 'dns' }}
                chevron
              />
            </Link>
            {settings.tailscaleHost ? (
              <Link href="/onboarding" asChild>
                <RowGroupRow
                  title="Your PC"
                  subtitle={`${settings.pcName ?? settings.tailscaleHost} · ${settings.tailscaleHost}`}
                  detail="Update address or API key"
                  icon={{ ios: 'desktopcomputer', android: 'computer', web: 'computer' }}
                  chevron
                />
              </Link>
            ) : null}
          </RowGroup>
          <SpendEntryRow />
        </View>

        <View style={styles.section}>
          <SectionHeader title="Privacy" />
          <RowGroup>
            <RowGroupRow
              title={APP_LOCK_LABEL}
              detail={appLockReason ? appLockUnavailableCopy(appLockReason) : APP_LOCK_SUMMARY}
              icon={{ ios: 'faceid', android: 'fingerprint', web: 'fingerprint' }}
              chevron={false}
              trailing={
                // A device that cannot ask for a fingerprint or Face ID gets the
                // module's own line, never a switch that could not finish.
                appLockReason ? undefined : (
                  <Switch
                    value={appLock}
                    onValueChange={handleAppLock}
                    trackColor={{ true: tokens.accentDeep, false: tokens.backgroundRaised }}
                    thumbColor={tokens.textPrimary}
                    accessibilityLabel={APP_LOCK_LABEL}
                    accessibilityState={{ checked: appLock }}
                  />
                )
              }
            />
            <RowGroupRow
              title={WIDGET_PRIVACY_LABEL}
              detail={WIDGET_PRIVACY_SUMMARY}
              icon={{ ios: 'rectangle.stack', android: 'widgets', web: 'widgets' }}
              chevron={false}
              trailing={
                <Switch
                  value={hideWidgetResult}
                  onValueChange={handleWidgetPrivacy}
                  trackColor={{ true: tokens.accentDeep, false: tokens.backgroundRaised }}
                  thumbColor={tokens.textPrimary}
                  accessibilityLabel={WIDGET_PRIVACY_LABEL}
                  accessibilityState={{ checked: hideWidgetResult }}
                />
              }
            />
          </RowGroup>
        </View>

        <View style={styles.section}>
          <SectionHeader title="Voice" />
          <Card variant="surface" padding={Spacing.three} style={styles.card}>
            <Text variant="headline">Power hands-free with</Text>
            <Text variant="caption" color="secondary">
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
            <View style={styles.voiceRows}>
              {VOICE_ENGINE_ROWS.map((row) => {
                const selected = voiceEngine === row.id;
                return (
                  <Pressable
                    key={row.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${row.label}. ${row.summary}`}
                    onPress={() => handleVoiceEngine(row.id)}
                    style={[
                      styles.voiceRow,
                      { backgroundColor: selected ? tokens.backgroundRaised : tokens.backgroundInset },
                      selected ? { borderColor: tokens.accent } : null,
                    ]}>
                    <View style={styles.voiceText}>
                      <Text variant="callout" color={selected ? 'primary' : 'secondary'}>
                        {row.label}
                      </Text>
                      <Text variant="caption" color="tertiary">
                        {row.summary}
                      </Text>
                      <Text variant="caption" color="tertiary">
                        {voiceReadiness(row.id, voiceCapabilities, voiceCheckState, voiceCheckError)}
                      </Text>
                    </View>
                    <Icon
                      name={
                        selected
                          ? { ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }
                          : { ios: 'circle', android: 'radio_button_unchecked', web: 'radio_button_unchecked' }
                      }
                      size={20}
                      color={selected ? 'accent' : 'textTertiary'}
                    />
                  </Pressable>
                );
              })}
              <View style={[styles.voiceRow, styles.voiceRowDisabled, { backgroundColor: tokens.backgroundInset }]}>
                <View style={styles.voiceText}>
                  <Text variant="callout" color="tertiary">
                    {GROK_ROW_LABEL}
                  </Text>
                  <Text variant="caption" color="tertiary">
                    {GROK_DISABLED_REASON}
                  </Text>
                </View>
                <Badge label="Unavailable" tone="neutral" dot={false} />
              </View>
            </View>
            <View style={styles.voiceMeta}>
              <Text variant="caption" color="secondary">
                Today
              </Text>
              <Text variant="caption" color="tertiary" style={styles.voiceMetaText}>
                {voiceUsageCopy(
                  voiceCapabilities?.usedToday,
                  voiceCapabilities?.lastError,
                  voiceUsageReadState,
                )}
              </Text>
            </View>
            {installing ? (
              <View style={styles.voiceMeta}>
                <Text variant="caption" color="accent">
                  Installing on this PC…
                </Text>
                <Text variant="caption" color="tertiary" style={styles.voiceMetaText}>
                  {installNote ?? 'This can take a few minutes.'}
                </Text>
              </View>
            ) : voiceCapabilities?.engines.local?.state === 'not-installed' || installNote ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Install on this PC"
                onPress={handleVoiceInstall}
                style={[styles.installRow, { backgroundColor: tokens.accentMuted }]}>
                <Icon name={{ ios: 'arrow.down.circle', android: 'download', web: 'download' }} size={18} color="accent" />
                <View style={styles.voiceText}>
                  <Text variant="callout" color="accent">
                    Install on this PC (≈2 GB download)
                  </Text>
                  <Text variant="caption" color="tertiary">
                    {installNote ?? 'Downloads the speech models to the Gate PC.'}
                  </Text>
                </View>
              </Pressable>
            ) : null}
          </Card>
        </View>

        <View style={styles.section}>
          <SectionHeader title="Notifications" />
          <NotificationsSection />
        </View>

        <View style={styles.section}>
          <SectionHeader title="Approvals" />
          <Card variant="surface" padding={Spacing.three} style={styles.card}>
            <View style={styles.cardTitleRow}>
              <Text variant="headline">Decision history</Text>
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
                <Text variant="caption" color="secondary">
                  {approvalAuditSummaryCopy(audit.length)}
                </Text>
                {audit.slice(0, 5).map((record) => (
                  <Text key={`${record.approvalId}-${record.at}`} variant="caption" color="tertiary">
                    {approvalAuditCopy(record)}
                  </Text>
                ))}
              </>
            )}
          </Card>
        </View>

        {activeGateway ? (
          <View style={styles.section}>
            <SectionHeader title="This device" />
            <TransportSecurityCard url={activeGateway.url} tlsFingerprint={activeGateway.tlsFingerprint} />
            <Card variant="surface" padding={Spacing.three} style={styles.card}>
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
              <Text variant="caption" color="tertiary">
                Used for gateway pairing and access requests. The private key remains in secure storage.
              </Text>
            </Card>
          </View>
        ) : null}

        <View style={styles.section}>
          <SectionHeader title="This build" />
          <RowGroup>
            <Link href="/gateway/diagnostics" asChild>
              <RowGroupRow
                title="Runtime environment"
                subtitle="What this build's engine actually provides"
                icon={{ ios: 'cpu', android: 'memory', web: 'memory' }}
                chevron
              />
            </Link>
          </RowGroup>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: Spacing.four - 4,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.five,
    gap: Spacing.four,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.one,
  },
  identityText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  identityName: {
    fontSize: 30,
    lineHeight: 36,
  },
  identityStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  section: {
    gap: Spacing.two,
  },
  card: {
    borderRadius: Radius.lg,
    gap: Spacing.two,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  voiceRows: {
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three - 4,
    paddingHorizontal: Spacing.three - 4,
    paddingVertical: Spacing.three - 4,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
  voiceRowDisabled: {
    opacity: 0.6,
  },
  voiceText: {
    flex: 1,
    gap: 2,
  },
  voiceMeta: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.two,
    paddingHorizontal: Spacing.one,
  },
  voiceMetaText: {
    flex: 1,
  },
  installRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 4,
    padding: Spacing.three - 4,
    borderRadius: Radius.md,
  },
});
