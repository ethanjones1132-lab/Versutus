// ─── Settings → Notifications (Solution A5/A6) ─────────────────────────────
// This device's relay preferences live on the Gate (`notifications.*`), keyed
// by the paired-device grant: the enable toggle, rich bodies, quiet hours, a
// per-Bot allowlist, widget updates, and the Gate's own test round trip.

import { useEffect, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { Button, Card, ErrorCard, Icon, Skeleton, Text, TextField } from '@/components/ui';
import { useTokens } from '@/hooks/use-tokens';
import { useNotificationPreferences } from '@/hooks/use-notification-preferences';
import { useGateway } from '@/context/gateway-provider';
import {
  botFilterRows,
  formatMinutes,
  parseQuietHoursInput,
  toggleBotFilter,
} from '@/lib/notifications/preference-forms';
import { Spacing } from '@/constants/tokens';

/** What the filter rows need of a Bot; the rest of the roster DTO is not drawn. */
type RosterBot = { id: string; displayName: string };

/**
 * How long a roster this device has already read stands as the answer. A connect
 * inside this window is the same Gate coming back — a blip, a resume, a screen
 * that remounted — and re-reading it spends a `/v1/bots` on an inventory nothing
 * has had the chance to change. Past it the list is revalidated, and only then.
 */
const ROSTER_REVALIDATE_MS = 30_000;

/**
 * The last good roster per gateway, and the reads still in the air.
 *
 * FALLBACK, and it is a real limitation: the app's shared roster cache is Chat's
 * (`readCached('roster', …)` in `@/lib/cache/swr-store`), and it is not reachable
 * from this card — the provider hands out an uncached `listBots` and no roster
 * field, so there is nothing to borrow. Until the provider can serve that read,
 * the minimum is kept here: module-level so two mounted copies of this card, and
 * a re-render that re-runs the effect, spend ONE read between them.
 */
const rosterCache = new Map<string, { bots: RosterBot[]; readAt: number }>();
const rosterReads = new Map<string, Promise<RosterBot[]>>();
/** The filter before anything has been read: no roster, only the stored ids. */
const NO_BOTS: RosterBot[] = [];

/** One `/v1/bots` per gateway, shared by everything waiting on it. */
function readRoster(gatewayId: string, listBots: () => Promise<{ id: string; displayName: string }[]>): Promise<RosterBot[]> {
  const inFlight = rosterReads.get(gatewayId);
  if (inFlight) return inFlight;
  const read: Promise<RosterBot[]> = listBots()
    .then((bots) => {
      const named = bots.map(({ id, displayName }) => ({ id, displayName }));
      rosterCache.set(gatewayId, { bots: named, readAt: Date.now() });
      return named;
    })
    .finally(() => {
      if (rosterReads.get(gatewayId) === read) rosterReads.delete(gatewayId);
    });
  rosterReads.set(gatewayId, read);
  return read;
}

export function NotificationsSection() {
  const tokens = useTokens();
  const {
    prefs,
    loading,
    saving,
    sendingTest,
    permission,
    error,
    testResult,
    connected,
    synced,
    setPatch,
    setEnabled,
    sendTest,
    reload,
  } = useNotificationPreferences();

  const [quietStart, setQuietStart] = useState('');
  const [quietEnd, setQuietEnd] = useState('');
  const [quietError, setQuietError] = useState<string | null>(null);
  // Whether the fields hold an edit the Gate has not taken. While it does, they
  // are the operator's: a stored window arriving from anywhere — another switch
  // on this card, another device, the Gate's own default — must not land on top
  // of what is being typed.
  const [quietDirty, setQuietDirty] = useState(false);

  // The roster feeds the switch rows. It is the last known good one: the card
  // paints it before the network is asked, a connect inside the freshness window
  // asks nothing, and a refused read keeps what the operator was looking at —
  // a failed read used to clear the filter to `[]`, which reads as "no Bots"
  // about a Gate that had one a moment ago.
  const { listBots, activeGateway } = useGateway();
  // The cache is keyed by gateway, and so is the answer a live read produced: a
  // switch is a different inventory, and one Gate's Bots must never be named for
  // another's. No id means no second Gate to confuse it with.
  const gatewayId = activeGateway?.id ?? '';
  // Two lists, in order of authority: what a read really answered for THIS
  // gateway, and what this device already had. The remembered one is what paints
  // before the network is asked — deriving it here is the paint, with no effect
  // and no extra render in between.
  const remembered = rosterCache.get(gatewayId);
  const [answered, setAnswered] = useState<{ gatewayId: string; bots: RosterBot[] } | null>(null);
  const rosterBots = answered?.gatewayId === gatewayId ? answered.bots : remembered?.bots ?? NO_BOTS;
  useEffect(() => {
    if (!connected) return undefined;
    let live = true;
    const held = rosterCache.get(gatewayId);
    // Fresh enough is already the answer: this connect reads nothing.
    if (held && Date.now() - held.readAt < ROSTER_REVALIDATE_MS) return undefined;
    void readRoster(gatewayId, listBots)
      .then((bots) => {
        if (live) setAnswered({ gatewayId, bots });
      })
      .catch(() => {
        // Only a landed read may replace the list. A refusal keeps what is on
        // screen, and an empty-but-ok answer is the Gate telling the truth.
      });
    return () => {
      live = false;
    };
  }, [connected, gatewayId, listBots]);

  const filterRows = botFilterRows(rosterBots, prefs.botIds);

  // What the Gate has stored, as text. The hook answers every read and every
  // write with a FRESH row, so these are the window's VALUES and not the row's
  // identity: an identity dependency re-seeded the fields from any other switch
  // on this card and threw away what the operator was typing.
  const storedStart = prefs.quietHours ? formatMinutes(prefs.quietHours.startMinutes) : '';
  const storedEnd = prefs.quietHours ? formatMinutes(prefs.quietHours.endMinutes) : '';

  // The Gate is the authority for the window it HOLDS; the fields are the
  // operator's until a save takes it. So a stored change re-seeds only while
  // there is no unsaved edit — after a save, and after a change made elsewhere
  // while the draft is clean.
  useEffect(() => {
    if (quietDirty) return;
    const timer = setTimeout(() => {
      setQuietStart(storedStart);
      setQuietEnd(storedEnd);
    }, 0);
    return () => clearTimeout(timer);
  }, [quietDirty, storedStart, storedEnd]);

  if (!connected) {
    return (
      // Nothing to set here yet: one quiet line, not a box holding a paragraph.
      <View style={styles.quiet}>
        <Icon name={{ ios: 'bell.slash', android: 'notifications_off', web: 'notifications_off' }} size={15} color="textTertiary" />
        <Text variant="caption" color="tertiary" style={styles.quietText}>
          Connect to a Versutus Gate to manage push notifications. Hermes and OpenClaw gateways do not relay them.
        </Text>
      </View>
    );
  }

  const saveQuietHours = () => {
    const parsed = parseQuietHoursInput(quietStart, quietEnd);
    if ('error' in parsed) {
      setQuietError(parsed.error);
      return;
    }
    setQuietError(null);
    // The typed window is the operator's until the Gate takes it: a refusal
    // leaves it on screen to try again, and a taken save hands the fields back.
    void setPatch({ quietHours: parsed.quietHours }).then((saved) => {
      if (saved) setQuietDirty(false);
    });
  };

  const saveBotFilter = (rows: Parameters<typeof toggleBotFilter>[0]) => {
    // Row removals save immediately; there is no separate save button to lose
    // a switch toggle behind.
    return (botId: string, value: boolean) => {
      const patch = toggleBotFilter(rows, botId, value);
      void setPatch({ botIds: patch.botIds });
    };
  };

  return (
    <View style={styles.container}>
      {error ? (
        <ErrorCard
          cause={error}
          affected="Push notification preferences on this device"
          next="Retry — the switches below stay locked until the Gate's own settings are read."
          onRetry={() => void reload()}
        />
      ) : null}

      <Card variant="hero" padding={Spacing.three} style={styles.card}>
        <View style={styles.row}>
          <View style={styles.title}>
            <Text variant="eyebrow" color="tertiary" style={styles.eyebrow}>
              Relay
            </Text>
            <Text variant="headline">Push notifications</Text>
          </View>
          {loading ? (
            <Skeleton width={51} height={31} radius={16} />
          ) : (
            <Switch
              value={prefs.enabled}
              onValueChange={(value) => void setEnabled(value)}
              trackColor={{ true: tokens.accent, false: tokens.border }}
              thumbColor={tokens.textPrimary}
              disabled={saving || !synced}
              accessibilityLabel="Push notifications from this Gate"
              accessibilityState={{ checked: prefs.enabled }}
            />
          )}
        </View>
        <Text variant="caption" color="secondary">
          Runs, approvals, replies and routines arrive with the app backgrounded or killed. Permission is asked
          here — turning this on — never at launch.
          {permission === 'denied' ? ' The OS currently reports notifications as denied.' : ''}
        </Text>
      </Card>

      {loading ? (
        <>
          <Card variant="inset" padding={Spacing.three} style={styles.card}>
            <Skeleton width="90%" height={44} />
            <Skeleton width="76%" height={44} style={styles.gap} />
          </Card>
          <Card variant="inset" padding={Spacing.three} style={styles.card}>
            <Skeleton width="90%" height={44} />
            <Skeleton width="76%" height={44} style={styles.gap} />
          </Card>
          <Card variant="inset" padding={Spacing.three} style={styles.card}>
            <Skeleton width="90%" height={44} />
            <Skeleton width="76%" height={44} style={styles.gap} />
          </Card>
        </>
      ) : (
        <>
          <Card variant="inset" padding={Spacing.three} style={styles.card}>
            <View style={styles.row}>
              <Text variant="body">Rich message text</Text>
              <Switch
                value={prefs.richBody}
                onValueChange={(value) => void setPatch({ richBody: value })}
                trackColor={{ true: tokens.accent, false: tokens.border }}
                thumbColor={tokens.textPrimary}
                disabled={saving || !synced}
                accessibilityLabel="Include message text in notifications"
                accessibilityState={{ checked: prefs.richBody }}
              />
            </View>
            <Text variant="caption" color="secondary">
              Off means titles only — and the home-screen widget withholds the newest result too.
            </Text>
            <View style={styles.row}>
              <Text variant="body">Home-screen widget updates</Text>
              <Switch
                value={prefs.widgetUpdates}
                onValueChange={(value) => void setPatch({ widgetUpdates: value })}
                trackColor={{ true: tokens.accent, false: tokens.border }}
                thumbColor={tokens.textPrimary}
                disabled={saving || !synced}
                accessibilityLabel="Send data-only widget updates"
                accessibilityState={{ checked: prefs.widgetUpdates }}
              />
            </View>
          </Card>

          <Card variant="inset" padding={Spacing.three} style={styles.card}>
            <Text variant="headline">Quiet hours</Text>
            <Text variant="caption" color="secondary">
              No tray notices between these times, in this device&apos;s timezone. Empty clears the window.
            </Text>
            <View style={styles.timeRow}>
              <View style={styles.timeField}>
                <Text variant="caption" color="secondary">
                  From
                </Text>
                <TextField
                  value={quietStart}
                  onChangeText={(text) => {
                    setQuietStart(text);
                    setQuietDirty(true);
                  }}
                  placeholder="22:00"
                  accessibilityLabel="Quiet hours start, HH:MM"
                />
              </View>
              <View style={styles.timeField}>
                <Text variant="caption" color="secondary">
                  To
                </Text>
                <TextField
                  value={quietEnd}
                  onChangeText={(text) => {
                    setQuietEnd(text);
                    setQuietDirty(true);
                  }}
                  placeholder="07:00"
                  accessibilityLabel="Quiet hours end, HH:MM"
                />
              </View>
            </View>
            {quietError ? <Text color="secondary">{quietError}</Text> : null}
            <Button label={saving ? 'Saving…' : 'Save quiet hours'} onPress={saveQuietHours} disabled={saving || !synced} />
            <View style={styles.row}>
              <Text variant="body">Approvals pierce quiet hours</Text>
              <Switch
                value={prefs.quietHoursAllowApprovals}
                onValueChange={(value) => void setPatch({ quietHoursAllowApprovals: value })}
                trackColor={{ true: tokens.accent, false: tokens.border }}
                thumbColor={tokens.textPrimary}
                disabled={saving || !synced}
                accessibilityLabel="Let approval notices through during quiet hours"
                accessibilityState={{ checked: prefs.quietHoursAllowApprovals }}
              />
            </View>
            <Text variant="caption" color="secondary">
              An approval waits on you before a run may continue. With this on, only approvals ring during the window —
              replies, runs and routines stay quiet. Off keeps quiet hours absolute.
            </Text>
          </Card>

          <Card variant="inset" padding={Spacing.three} style={styles.card}>
            <Text variant="headline">Bot filter</Text>
            <Text variant="caption" color="secondary">
              Switch a Bot on to let its replies and routines reach this device. With every switch off, every Bot may
              notify. Approvals and run results always come through.
            </Text>
            {filterRows.map((row) => (
              <View key={row.botId} style={styles.row}>
                <Text variant="body" style={styles.filterName} numberOfLines={1}>
                  {row.kind === 'bot' ? row.displayName : row.botId}
                  {row.kind === 'unknown' ? (
                    <Text variant="caption" color="secondary">
                      {' '}
                      (unknown id)
                    </Text>
                  ) : null}
                </Text>
                <Switch
                  value={row.enabled}
                  onValueChange={(value) => saveBotFilter(filterRows)(row.botId, value)}
                  trackColor={{ true: tokens.accent, false: tokens.border }}
                  thumbColor={tokens.textPrimary}
                  disabled={saving || !synced}
                  accessibilityLabel={`Allow ${row.kind === 'bot' ? row.displayName : row.botId} notifications`}
                  accessibilityState={{ checked: row.enabled }}
                />
              </View>
            ))}
          </Card>
        </>
      )}

      <Card variant="inset" padding={Spacing.three} style={styles.card}>
        <Text variant="headline">Test</Text>
        <Text variant="caption" color="secondary">
          The Gate sends one notice to this device. Background or kill the app first — a notice arriving
          while the app is open is deliberately not shown.
        </Text>
        <Button
          label={sendingTest ? 'Sending…' : 'Send test notification'}
          onPress={() => void sendTest()}
          disabled={sendingTest || saving}
          busy={sendingTest}
        />
        {testResult ? <Text color="secondary">{testResult}</Text> : null}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: Spacing.two },
  quiet: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.two, paddingHorizontal: Spacing.two },
  quietText: { flex: 1 },
  card: { gap: Spacing.two },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  title: { flex: 1, gap: 2 },
  eyebrow: { flexShrink: 1 },
  timeRow: { flexDirection: 'row', gap: Spacing.two },
  timeField: { flex: 1, gap: 4 },
  filterName: { flex: 1 },
  gap: { marginTop: Spacing.two },
});
