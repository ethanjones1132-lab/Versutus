import * as Clipboard from 'expo-clipboard';
import { Link, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  PageTitle,
  PressableScale,
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
import { haptics } from '@/lib/haptics';
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
import { isAuthRejection, isDeviceIdentityError } from '@/lib/gateway/errors';
import type { VoiceEngineCapabilities, VoiceEnginePreference } from '@/lib/voice/voice-engine-choice';
import {
  GROK_DISABLED_REASON,
  GROK_ROW_LABEL,
  VOICE_ENGINE_ROWS,
  voiceEngineReadinessCopy,
  voiceUsageCopy,
} from '@/lib/voice/voice-engine-copy';

/**
 * The install watch's wait, and the cap its backoff grows to. A 2 GB download on
 * a relayed path does not report progress every two seconds, and polling a Gate
 * that busy for thirty minutes is the phone's work, not the operator's.
 */
const INSTALL_POLL_FIRST_DELAY_MS = 2_000;
const INSTALL_POLL_MAX_DELAY_MS = 10_000;

/** How long the phone keeps watching before it hands the wait back. */
const INSTALL_POLL_BUDGET_MS = 10 * 60_000;

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
  const router = useRouter();
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
  // The install watch's own cancellation. The chain outlives the screen by
  // nature — leaving Settings must stop the RPCs, not just hide the rows.
  const installCancelRef = useRef<AbortController | null>(null);
  // The wait the watch is parked on, so leaving the screen does not leave a
  // ten-second timer behind to wake the JS thread for nobody. The poll itself
  // stops on the abort; this is the timer that outlived it.
  const installWaitRef = useRef<(() => void) | null>(null);
  // Which voice read is the newest. A slow answer from before a reconnect must
  // never land on top of a newer one, so each run takes a number.
  const voiceReadRef = useRef(0);
  // How many engine writes are on their way to the store. The connected edge
  // re-reads the stored blob to show what this phone holds, and while a write is
  // in flight that blob is the OLD one: re-asserting it would snap the row back
  // under the operator's finger, and the write's own success path never undoes it.
  const voiceEngineWritesRef = useRef(0);
  // A preference whose write did not land is named where the control is, not
  // left as a control claiming a value this phone does not hold.
  const [widgetPrivacyError, setWidgetPrivacyError] = useState<string | null>(null);
  const [voiceEngineError, setVoiceEngineError] = useState<string | null>(null);
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
    // The Retry joins the same numbered race as the effect below: a slow
    // answer from the read it replaced may not land on top of this one.
    voiceReadRef.current += 1;
    setVoiceCheckState('checking');
    setVoiceCheckError(null);
    const ticket = voiceReadRef.current;
    void readVoiceCapabilities().then((result) => {
      if (voiceReadRef.current !== ticket) return;
      applyVoiceRead(result);
    });
  }, [readVoiceCapabilities, applyVoiceRead]);

  // The voice check follows the connection: the rows are read when the Gate is
  // there, and the connection is the only thing that can change the answer. It
  // is keyed on the connected/not-connected edge rather than on `status` itself,
  // because a monitor self-heal walks the intermediate statuses without the
  // Gate's voice readiness having changed. A read issued while the Gate is away
  // costs nothing: `gatewayRequest` refuses before it reaches the network, and
  // the rows then name that refusal instead of keeping the last "ready".
  const connected = status === 'connected';
  useEffect(() => {
    let cancelled = false;
    const ticket = (voiceReadRef.current += 1);
    void (async () => {
      setVoiceCheckState('checking');
      setVoiceCheckError(null);
      try {
        const stored = await loadAppSettings();
        // Only while nothing is in flight: a write's own value is the one this
        // row should show, and re-asserting the blob it has not reached yet is
        // how the row ends up naming an engine the store no longer holds.
        if (!cancelled && voiceReadRef.current === ticket && voiceEngineWritesRef.current === 0) {
          setVoiceEngine(stored.voiceEngine);
        }
        const result = await readVoiceCapabilities();
        if (cancelled || voiceReadRef.current !== ticket) return;
        applyVoiceRead(result);
      } catch (caught) {
        // Every exit from here is terminal. A throw from either awaited read —
        // the settings blob above most of all — used to leave the rows on
        // "Checking this PC…" for the rest of the session, with no Retry
        // because the ErrorCard that offers one only renders once the check has
        // failed.
        if (cancelled || voiceReadRef.current !== ticket) return;
        applyVoiceRead({ ok: false, error: caught instanceof Error ? caught.message : String(caught) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, readVoiceCapabilities, applyVoiceRead]);

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

  // The unmount edge is the cancellation: the poll is phone work against a
  // relayed path, and a screen nobody is looking at has no reason to keep it.
  // The pending wait is dropped with it, so no timer outlives the screen.
  useEffect(
    () => () => {
      installCancelRef.current?.abort();
      installWaitRef.current?.();
      installWaitRef.current = null;
    },
    [],
  );

  const handleVoiceEngine = useCallback(
    async (next: VoiceEnginePreference) => {
      const previous = voiceEngine;
      setVoiceEngine(next);
      setVoiceEngineError(null);
      voiceEngineWritesRef.current += 1;
      try {
        await saveAppSettings({ voiceEngine: next });
      } catch {
        // The row put itself on an engine this phone did not manage to store.
        // It goes back to the one that IS stored, and says why: a preference
        // that reverts on the next launch must not look kept.
        setVoiceEngine(previous);
        setVoiceEngineError('This phone could not store that choice, so it is not kept.');
      } finally {
        voiceEngineWritesRef.current -= 1;
      }
    },
    [voiceEngine],
  );

  // Install the PC voice models from the phone: start the Gate's install, then
  // watch its status until it leaves `installing` and refresh capabilities. The
  // watch is cancellable (leaving the screen ends it), backs off so a busy Gate
  // is not polled at a fixed rate, and is bounded: a 2 GB download this phone
  // stops watching is still a download the PC finishes.
  const handleVoiceInstall = useCallback(async () => {
    installCancelRef.current?.abort();
    // A watch already parked on a wait is released rather than left holding the
    // old watch's timer: the abort stops its RPCs, this drops its clock.
    installWaitRef.current?.();
    installWaitRef.current = null;
    const controller = new AbortController();
    installCancelRef.current = controller;
    const cancelled = () => controller.signal.aborted;
    // A cancellable wait. The timer is owned by the screen, so the unmount edge
    // clears it instead of waking the JS thread up to ten seconds later for a
    // poll that will not happen.
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          installWaitRef.current = null;
          resolve();
        }, ms);
        installWaitRef.current = () => clearTimeout(timer);
      });
    setInstalling(true);
    setInstallNote('Downloading the PC voice models…');
    try {
      // The device params are read once for the whole watch: `pushDeviceParams`
      // reads SecureStore and re-derives the ed25519 public key, which is far
      // too much work to repeat every poll for an id that changes only when the
      // identity is re-made — and a refusal from the Gate is the one thing that
      // says it is stale. The read itself can refuse (an identity this phone
      // cannot name or re-make), and then there is no install to start at all:
      // the row must say that rather than keep claiming a download the PC never
      // began, and the refusal must not escape a handler nothing catches.
      let params: { deviceId: string };
      try {
        params = await pushDeviceParams();
      } catch (caught) {
        if (!cancelled()) {
          setInstallNote(
            isDeviceIdentityError(caught)
              ? 'This phone could not make its device identity, so the Gate could not start the install.'
              : 'The Gate could not start the install.',
          );
        }
        return;
      }
      if (cancelled()) return;
      try {
        await gatewayRequest('voice.install.start', params);
      } catch {
        if (!cancelled()) setInstallNote('The Gate could not start the install.');
        return;
      }
      let waited = 0;
      let delay = INSTALL_POLL_FIRST_DELAY_MS;
      while (true) {
        await wait(delay);
        if (cancelled()) return;
        waited += delay;
        delay = Math.min(delay * 2, INSTALL_POLL_MAX_DELAY_MS);
        if (waited >= INSTALL_POLL_BUDGET_MS) {
          setInstallNote('Still installing on the PC — this phone stopped watching, check back later.');
          break;
        }
        let install: { state?: string; reason?: string } | null = null;
        try {
          install = await gatewayRequest<{ state?: string; reason?: string }>(
            'voice.install.status',
            params,
          );
        } catch (caught) {
          if (isAuthRejection(caught)) {
            try {
              params = await pushDeviceParams();
            } catch {
              // Keep the params this watch already has: there is no next poll,
              // and the closing capabilities read can still use a fresh one.
            }
          }
          break;
        }
        if (cancelled()) return;
        setInstallNote(install?.reason ?? null);
        if (install?.state !== 'installing') break;
      }
      if (cancelled()) return;
      try {
        const read = await gatewayRequest<VoiceEngineCapabilities>('voice.capabilities', params);
        // The refresh after an install publishes the SAME read state as the
        // first read, so a Gate that once refused does not stay "failed" while
        // freshly readable rows sit beneath the error card.
        if (!cancelled()) applyVoiceRead({ ok: true, capabilities: read });
      } catch {
        // keep the last known capabilities
      }
    } catch {
      // The handler's promise is what `onPress` calls, with nothing attached to
      // it, so no rejection may leave here: one that does is an unhandled
      // rejection AND a note still claiming a download that never started. Every
      // read below handles its own refusal; this is the backstop for anything
      // unforeseen in the watch, and it names the same refusal the Gate does.
      if (!cancelled()) setInstallNote('The Gate could not start the install.');
    } finally {
      // Every exit — success, refusal, budget, cancellation — clears the row, so
      // "Installing on this PC…" cannot outlive the watch that drew it.
      if (installCancelRef.current === controller) installCancelRef.current = null;
      installWaitRef.current = null;
      if (!cancelled()) setInstalling(false);
    }
  }, [gatewayRequest, applyVoiceRead]);

  const handleWidgetPrivacy = useCallback(
    async (next: boolean) => {
      const previous = hideWidgetResult;
      setHideWidgetResult(next);
      const stored = await saveWidgetResultHidden(next);
      if (stored) {
        setWidgetPrivacyError(null);
        return;
      }
      // The write did not land. The switch goes back to what this phone holds
      // and the row names the refusal: the widget fold reads the stored value
      // either way, so a switch left on a value that is not there is a lie.
      setHideWidgetResult(previous);
      setWidgetPrivacyError('This phone could not store that preference, so it is not kept.');
    },
    [hideWidgetResult],
  );

  const copyText = useCallback(async (text: string) => {
    await Clipboard.setStringAsync(text);
    await haptics.light();
    setCopied('id');
    setTimeout(() => setCopied(null), 2000);
  }, []);

  const gateName = settings.pcName ?? activeGateway?.name ?? 'No gateway yet';
  // The Today line reads the same read state the rows do: an in-flight or
  // refused read measured nothing and may not print a measured zero.
  const voiceUsageReadState =
    voiceCheckState === 'checking' ? 'loading' : voiceCheckState === 'failed' ? 'error' : 'ready';

  return (
    <Screen edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Settings opens like every page: the serif title in the lamp's
            light, and the Gate it is talking to as its one status line — the
            mark, the name, the connection. One serif line, no header bar. */}
        <PageTitle
          title="Settings"
          leading={
            <PressableScale
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/chat'))}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close settings"
              style={styles.close}>
              <Icon name={{ ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }} size={20} color="textSecondary" />
            </PressableScale>
          }
          status={
            <View style={styles.identityStatus}>
              <VersutusMark size={22} />
              <Text variant="callout" numberOfLines={1} style={styles.identityName}>
                {gateName}
              </Text>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: status === 'connected' ? tokens.statusConnected : tokens.textTertiary },
                ]}
              />
              <Text variant="caption" color="secondary" numberOfLines={1} style={styles.identityDetail}>
                {status === 'connected' ? 'Connected' : 'Not connected'}
                {activeGateway?.kind ? ` · ${activeGateway.kind === 'hermes' ? 'Hermes Gate' : activeGateway.kind}` : ''}
              </Text>
            </View>
          }
        />

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
              detail={widgetPrivacyError ?? WIDGET_PRIVACY_SUMMARY}
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
          <Card variant="stage" padding={Spacing.three} style={styles.card}>
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
                      selected ? { backgroundColor: tokens.backgroundRaised, borderColor: tokens.accent } : null,
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
              <View style={[styles.voiceRow, styles.voiceRowDisabled]}>
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
            {voiceEngineError ? (
              <Text variant="caption" color="tertiary">
                {voiceEngineError}
              </Text>
            ) : null}
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
          <Card variant="stage" padding={Spacing.three} style={styles.card}>
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
            <Card variant="stage" padding={Spacing.three} style={styles.card}>
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
    paddingTop: Spacing.two,
    paddingBottom: Spacing.five,
    gap: Spacing.four,
  },
  close: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityStatus: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    minWidth: 0,
  },
  identityName: {
    flexShrink: 1,
  },
  identityDetail: {
    flexShrink: 1,
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
    gap: 2,
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
