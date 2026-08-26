import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BaseSheet, Divider, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { freshnessLabel, type CronTurn } from '@/lib/gateway/cron';

/** How often the open view asks the host for new turns. */
const POLL_MS = 3000;

export type CronRunSheetProps = {
  /** The run's id; null renders nothing (sheet dismissed). */
  runId: string | null;
  onClose: () => void;
};

/**
 * Read-only window into one cron run.
 *
 * Hermes has no event stream for cron, so this polls while it is open and
 * stops the moment it closes — no background drain. The freshness stamp is not
 * decoration: a polled view that silently stops updating looks exactly like a
 * job that went quiet, so it always says when it last heard from the host, and
 * a failed poll leaves the last good transcript standing rather than blanking
 * the screen.
 */
export function CronRunSheet({ runId, onClose }: CronRunSheetProps) {
  const { cron } = useGateway();
  const [turns, setTurns] = useState<CronTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [polledAt, setPolledAt] = useState<number | null>(null);
  const [, forceTick] = useState(0);
  const cancelled = useRef(false);

  const poll = useCallback(async () => {
    if (!runId) return;
    try {
      const next = await cron.transcript(runId);
      if (cancelled.current) return;
      setTurns(next);
      setPolledAt(Date.now());
      setError(null);
    } catch (caught) {
      if (cancelled.current) return;
      // Keep the last good transcript: a poll failure is a gap in freshness,
      // not evidence that the run produced nothing.
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [cron, runId]);

  // State resets by REMOUNT, not by writing it here: the parent keys this
  // sheet on the run id, so a different run arrives as a fresh component with
  // empty state. Clearing inside the effect would cascade a render and trips
  // react-hooks/set-state-in-effect for exactly that reason.
  useEffect(() => {
    cancelled.current = false;
    if (!runId) return undefined;

    // First poll is deferred a tick, same as every other loader in the app:
    // starting it synchronously would write state during the effect body.
    const first = setTimeout(() => { void poll(); }, 0);
    const timer = setInterval(() => { void poll(); }, POLL_MS);
    // Re-render once a second so the "updated Ns ago" stamp keeps counting
    // even between polls — a frozen stamp would itself be misleading.
    const tick = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => {
      cancelled.current = true;
      clearTimeout(first);
      clearInterval(timer);
      clearInterval(tick);
    };
  }, [poll, runId]);

  if (!runId) return null;

  return (
    <BaseSheet visible onClose={onClose} title="Run transcript" eyebrow="READ ONLY">
      <ScrollView contentContainerStyle={styles.body}>
        <Text variant="micro" color="tertiary" selectable>{runId}</Text>
        <Divider />

        {error ? (
          <Text variant="caption" color="statusDisconnected" selectable>
            {error}
          </Text>
        ) : null}

        {turns.length === 0 && !error ? (
          <Text variant="caption" color="secondary">
            {polledAt ? 'This run recorded no turns.' : 'Loading…'}
          </Text>
        ) : null}

        {turns.map((turn) => (
          <View key={turn.id} style={styles.turn}>
            <Text variant="micro" color="tertiary">
              {turn.role.toUpperCase()}
              {turn.toolName ? ` · ${turn.toolName}` : ''}
            </Text>
            <Text variant="caption" selectable>{turn.text || '—'}</Text>
          </View>
        ))}

        <Divider />
        <Text variant="micro" color="tertiary">
          {freshnessLabel(polledAt)} · read-only
        </Text>
      </ScrollView>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: Spacing.two, paddingBottom: Spacing.five },
  turn: { gap: 2 },
});
