// ─── Settings → Notifications (Solution A5/A6) ─────────────────────────────
// This device's relay preferences live on the Gate (`notifications.*`), keyed
// by the paired-device grant: the enable toggle, rich bodies, quiet hours, a
// per-Bot allowlist, widget updates, and the Gate's own test round trip.

import { useEffect, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { Button, Card, Text, TextField } from '@/components/ui';
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
    setPatch,
    setEnabled,
    sendTest,
  } = useNotificationPreferences();

  const [quietStart, setQuietStart] = useState('');
  const [quietEnd, setQuietEnd] = useState('');
  const [quietError, setQuietError] = useState<string | null>(null);

  // The roster feeds the switch rows; a failed read shows the stored ids as
  // unknowns rather than an empty filter that reads as "no Bots".
  const { listBots } = useGateway();
  const [rosterBots, setRosterBots] = useState<{ id: string; displayName: string }[]>([]);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void listBots()
      .then((bots) => {
        if (!cancelled) setRosterBots(bots.map(({ id, displayName }) => ({ id, displayName })));
      })
      .catch(() => {
        if (!cancelled) setRosterBots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, listBots]);

  const filterRows = botFilterRows(rosterBots, prefs.botIds);

  // The Gate is the authority: seed the fields from what it reports. Deferred
  // past the effect (the section pattern) so the seed cannot cascade renders.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuietStart(prefs.quietHours ? formatMinutes(prefs.quietHours.startMinutes) : '');
      setQuietEnd(prefs.quietHours ? formatMinutes(prefs.quietHours.endMinutes) : '');
    }, 0);
    return () => clearTimeout(timer);
  }, [prefs.quietHours]);

  if (!connected) {
    return (
      <Card variant="inset" padding={Spacing.three}>
        <Text color="secondary">
          Connect to a Versutus Gate to manage push notifications. Hermes and OpenClaw gateways do not relay them.
        </Text>
      </Card>
    );
  }

  const saveQuietHours = () => {
    const parsed = parseQuietHoursInput(quietStart, quietEnd);
    if ('error' in parsed) {
      setQuietError(parsed.error);
      return;
    }
    setQuietError(null);
    void setPatch({ quietHours: parsed.quietHours });
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
      <Card variant="hero" padding={Spacing.three} style={styles.card}>
        <View style={styles.row}>
          <View style={styles.title}>
            <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
              Relay
            </Text>
            <Text variant="headline">Push notifications</Text>
          </View>
          <Switch
            value={prefs.enabled}
            onValueChange={(value) => void setEnabled(value)}
            trackColor={{ true: tokens.accent, false: tokens.border }}
            thumbColor={tokens.textPrimary}
            disabled={saving || loading}
            accessibilityLabel="Push notifications from this Gate"
            accessibilityState={{ checked: prefs.enabled }}
          />
        </View>
        <Text variant="caption" color="secondary">
          Runs, approvals, replies and routines arrive with the app backgrounded or killed. Permission is asked
          here — turning this on — never at launch.
          {permission === 'denied' ? ' The OS currently reports notifications as denied.' : ''}
        </Text>
      </Card>

      <Card variant="inset" padding={Spacing.three} style={styles.card}>
        <View style={styles.row}>
          <Text variant="body">Rich message text</Text>
          <Switch
            value={prefs.richBody}
            onValueChange={(value) => void setPatch({ richBody: value })}
            trackColor={{ true: tokens.accent, false: tokens.border }}
            thumbColor={tokens.textPrimary}
            disabled={saving}
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
            disabled={saving}
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
              onChangeText={setQuietStart}
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
              onChangeText={setQuietEnd}
              placeholder="07:00"
              accessibilityLabel="Quiet hours end, HH:MM"
            />
          </View>
        </View>
        {quietError ? <Text color="secondary">{quietError}</Text> : null}
        <Button label={saving ? 'Saving…' : 'Save quiet hours'} onPress={saveQuietHours} disabled={saving} />
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
              disabled={saving}
              accessibilityLabel={`Allow ${row.kind === 'bot' ? row.displayName : row.botId} notifications`}
              accessibilityState={{ checked: row.enabled }}
            />
          </View>
        ))}
      </Card>

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

      {loading ? (
        <Text variant="caption" color="secondary">
          Loading preferences from the Gate…
        </Text>
      ) : null}
      {error ? <Text color="secondary">{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: Spacing.two },
  card: { gap: Spacing.two },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  title: { flex: 1, gap: 2 },
  eyebrow: { textTransform: 'uppercase' },
  timeRow: { flexDirection: 'row', gap: Spacing.two },
  timeField: { flex: 1, gap: 4 },
  filterName: { flex: 1 },
});
