import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BaseSheet, Divider, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { freshnessLabel, type CronTurn } from '@/lib/gateway/cron';
import { useNow } from '@/hooks/use-now';

/** How often the open view asks the host for new turns. */
const POLL_MS = 3000;
/**
 * The wait before the next read, by consecutive refusals: a Gate that is not
 * answering does not get re-asked on the same cadence as a healthy one, and the
 * last rung repeats. Indexed by the failure count, so the first refusal waits
 * `POLL_BACKOFF_MS[1]` and a healthy read waits `POLL_MS`.
 */
const POLL_BACKOFF_MS = [POLL_MS, 6_000, 12_000, 30_000] as const;

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
  const cancelled = useRef(false);
  // Consecutive refusals — the last error stays on screen while this climbs,
  // and a healthy read drops it back to zero.
  const refusals = useRef(0);

  const poll = useCallback(async () => {
    if (!runId || cancelled.current) return;
    try {
      const next = await cron.transcript(runId);
      if (cancelled.current) return;
      refusals.current = 0;
      setTurns(next);
      setPolledAt(Date.now());
      setError(null);
    } catch (caught) {
      if (cancelled.current) return;
      refusals.current += 1;
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
    refusals.current = 0;
    if (!runId) return undefined;

    /**
     * The next read is armed by the one that just settled, never on a tick of
     * its own: one read outstanding at a time, and a refusal buys a longer wait
     * before the Gate is asked again. `setInterval` armed a read every 3s
     * whatever the last one was doing, so a link slow enough to sit on the
     * transport's 30s ceiling piled ten reads onto a Gate that serves one
     * request at a time.
     */
    let pending: ReturnType<typeof setTimeout> | null = null;
    const scheduleNext = () => {
      if (cancelled.current || pending !== null) return;
      const rung = POLL_BACKOFF_MS[Math.min(refusals.current, POLL_BACKOFF_MS.length - 1)];
      pending = setTimeout(() => {
        pending = null;
        void poll().then(scheduleNext, scheduleNext);
      }, rung ?? POLL_MS);
    };

    // First poll is deferred a tick, same as every other loader in the app:
    // starting it synchronously would write state during the effect body.
    const first = setTimeout(() => {
      void poll().then(scheduleNext, scheduleNext);
    }, 0);
    // The freshness stamp (FreshnessLabel below) owns its own per-second tick,
    // so the turn list and the rest of the sheet stay still between polls.
    return () => {
      cancelled.current = true;
      clearTimeout(first);
      if (pending !== null) clearTimeout(pending);
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
          <>
            {!polledAt ? (
              <>
                <Skeleton width="90%" height={44} />
                <Skeleton width="76%" height={44} style={styles.gap} />
              </>
            ) : null}
            <Text variant="caption" color="secondary">
              {polledAt ? 'This run recorded no turns.' : 'Loading…'}
            </Text>
          </>
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
        <FreshnessLabel polledAt={polledAt} />
      </ScrollView>
    </BaseSheet>
  );
}

/**
 * The "updated Ns ago" stamp. Owns its own per-second tick so the rest of the
 * sheet — the turn list, the error line — stays still between polls. A frozen
 * stamp would itself be misleading, but re-rendering the whole transcript once
 * a second just to advance the clock remounted every row for no content change.
 */
function FreshnessLabel({ polledAt }: { polledAt: number | null }) {
  const now = useNow(1000, true);
  return (
    <Text variant="micro" color="tertiary">
      {freshnessLabel(polledAt, now)} · read-only
    </Text>
  );
}

const styles = StyleSheet.create({
  body: { gap: Spacing.two, paddingBottom: Spacing.five },
  turn: { gap: 2 },
  gap: { marginTop: Spacing.two },
});
