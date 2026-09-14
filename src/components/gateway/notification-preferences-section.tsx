import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  loadPushPreferences,
  pushPreferencesAdvertised,
  setPushPreferences,
  type PushPreferences,
} from '@/lib/notifications/push-preferences';

/**
 * The master toggle, the rich-body opt-in and the per-Bot allowlist (A6 / A8,
 * the preferences pane — quiet hours remains its own slice). Shown only when
 * the gateway's manifest advertises the preferences methods: the
 * capability-gated pattern, the same rule `RpcMethodsSection` reads the
 * already-held `rpcMethods` array by.
 *
 * The switch paints the state the Gate answered, never a flag of its own:
 * until the pane has read the paired-device row it shows a caption instead of
 * an untold position, and a refused patch leaves the previous answer standing
 * rather than the optimistically-painted one — the operator sees the relay
 * did not take the change while the read is retried on the way back.
 */
export function NotificationPreferencesSection() {
  const { status, activeGateway, capabilitySnapshot, gatewayRequest, listBots } = useGateway();
  const tokens = useTokens();
  const [preferences, setPreferences] = useState<PushPreferences | null>(null);
  const [unread, setUnread] = useState(false);
  const [botIds, setBotIds] = useState<string[] | null>(null);

  const gatewayId = activeGateway?.id;
  const advertised =
    status === 'connected' && pushPreferencesAdvertised(capabilitySnapshot.rpcMethods);

  useEffect(() => {
    let cancelled = false;
    void loadPushPreferences({ rpcRequest: gatewayRequest })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setPreferences(result.preferences);
          setUnread(false);
        } else {
          // An unread row paints the unknown state, never a fabricated switch position.
          setPreferences(null);
          setUnread(true);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setPreferences(null);
        setUnread(true);
      });
    return () => {
      cancelled = true;
    };
  }, [advertised, gatewayId, gatewayRequest]);

  // The per-Bot rows read the same roster the Bot roster screen holds, one
  // listBots call per gateway change — no polling, no cache beyond the read.
  // A roster that cannot be read paints no rows at all (the allowlist stays
  // invisible beside an unread inventory rather than guessing its shape); an
  // EMPTY-but-read roster is the host telling the truth: no Bots, no rows.
  useEffect(() => {
    let cancelled = false;
    void listBots()
      .then((bots) => {
        if (!cancelled) setBotIds(bots.map((bot) => bot.id));
      })
      .catch(() => {
        if (!cancelled) setBotIds(null);
      });
    return () => {
      cancelled = true;
    };
  }, [gatewayId, listBots]);

  const handleToggle = useCallback((field: 'enabled' | 'richBody', next: boolean) => {
    setPreferences((current) => (current ? { ...current, [field]: next } : current));
    void (async () => {
      const result = await setPushPreferences({ rpcRequest: gatewayRequest }, { [field]: next });
      // A refused patch snaps to what the Gate answered — or, on a failed
      // follow-up read, to the unknown state — never the unpainted promise.
      if (result.ok) {
        setPreferences(result.preferences);
        setUnread(false);
      } else {
        setPreferences(null);
        setUnread(true);
      }
    })();
  }, [gatewayRequest]);

  // One toggled Bot moves exactly its own name in the fold: absent fields
  // (enabled, richBody, quietHours) are never sent, so unchecking every Bot
  // still goes out as `botIds: []` — "push no Bots", never confused with
  // "leave the allowlist as is".
  const handleBotToggle = useCallback(
    (botId: string, next: boolean) => {
      setPreferences((current) => {
        if (!current) return current;
        const botIds = next
          ? current.botIds.includes(botId)
            ? current.botIds
            : [...current.botIds, botId]
          : current.botIds.filter((id) => id !== botId);
        const updated = { ...current, botIds };
        void (async () => {
          const result = await setPushPreferences(
            { rpcRequest: gatewayRequest },
            { botIds },
          );
          // The same refused-patch rule the two switches above hold: snap to
          // the Gate's answer, or to the unknown state on a failed read-back.
          if (result.ok) {
            setPreferences(result.preferences);
            setUnread(false);
          } else {
            setPreferences(null);
            setUnread(true);
          }
        })();
        return updated;
      });
    },
    [gatewayRequest],
  );

  // The gate decides before anything renders: a gateway that advertises
  // nothing new paints nothing new, and no stale answer survives it.
  if (!advertised) return null;

  return (
    <Card variant="surface" padding={Spacing.three} style={styles.card}>
      <View style={styles.sectionTitle}>
        <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
          Notifications
        </Text>
        <Text variant="headline">True push from this gateway</Text>
      </View>
      {unread ? (
        <Text variant="caption" color="tertiary">
          This gateway&apos;s notification preferences could not be read. They are off until it answers.
        </Text>
      ) : preferences === null ? (
        <Text variant="caption" color="tertiary">
          Reading this gateway&apos;s notification preferences…
        </Text>
      ) : (
        <>
          <Text variant="caption" color="secondary">
            {PREFERENCES_ENABLED_SUMMARY}
          </Text>
          <Switch
            value={preferences.enabled}
            onValueChange={(next) => handleToggle('enabled', next)}
            trackColor={{ true: tokens.accent, false: tokens.border }}
            thumbColor={tokens.textPrimary}
            accessibilityLabel={PREFERENCES_ENABLED_LABEL}
            accessibilityState={{ checked: preferences.enabled }}
          />
          <Text variant="caption" color="secondary">
            {PREFERENCES_RICH_BODY_SUMMARY}
          </Text>
          <Switch
            value={preferences.richBody}
            onValueChange={(next) => handleToggle('richBody', next)}
            trackColor={{ true: tokens.accent, false: tokens.border }}
            thumbColor={tokens.textPrimary}
            accessibilityLabel={PREFERENCES_RICH_BODY_LABEL}
            accessibilityState={{ checked: preferences.richBody }}
          />
          {botIds !== null && botIds.length > 0 ? (
            <View>
              <Text variant="caption" color="secondary">
                {PREFERENCES_BOTS_SUMMARY}
              </Text>
              {botIds.map((botId) => (
                <View key={botId} style={styles.botRow}>
                  <Text variant="body" style={styles.botName} numberOfLines={1}>
                    {botId}
                  </Text>
                  <Switch
                    value={preferences.botIds.includes(botId)}
                    onValueChange={(next) => handleBotToggle(botId, next)}
                    trackColor={{ true: tokens.accent, false: tokens.border }}
                    thumbColor={tokens.textPrimary}
                    accessibilityLabel={botAllowlistLabel(botId)}
                    accessibilityState={{ checked: preferences.botIds.includes(botId) }}
                  />
                </View>
              ))}
            </View>
          ) : null}
        </>
      )}
    </Card>
  );
}

const PREFERENCES_ENABLED_LABEL = 'Push notifications';
const PREFERENCES_ENABLED_SUMMARY =
  'Let this gateway reach this device when you are away from the screen — approvals, Routine results and finished replies. The message content stays on the gateway unless you opt in below.';

const PREFERENCES_RICH_BODY_LABEL = 'Rich message bodies';
const PREFERENCES_RICH_BODY_SUMMARY =
  'Include what the reply or result said in the notification itself. By default a push names the event only — no prompt text, no result bodies.';

const PREFERENCES_BOTS_SUMMARY =
  'Push from each Bot. Off means this device hears nothing from that one; with every Bot off, no push names a Bot.';

function botAllowlistLabel(botId: string): string {
  return `${botId} — Allow push`;
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.two,
  },
  sectionTitle: {
    gap: Spacing.one,
  },
  eyebrow: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  botRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  botName: {
    flexShrink: 1,
  },
});
