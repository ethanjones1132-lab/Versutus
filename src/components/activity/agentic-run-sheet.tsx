import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BaseSheet, Button, Divider, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { formatRunFailure } from '@/lib/gateway/run-failures';
import { runEventPreview } from '@/lib/gateway/runs';
import type { RunEvent } from '@/lib/gateway/types';

export type AgenticRunSheetProps = {
  /** The run's id; null renders nothing (sheet dismissed). */
  runId: string | null;
  /** Single-shot reader: subscribes to the gateway's replay stream and resolves with every event it emitted before the stream closed (or the abort fired). */
  loadEvents: (runId: string, signal: AbortSignal) => Promise<RunEvent[]>;
  onClose: () => void;
};

/**
 * Read-only window into one agentic run's full event stream.
 *
 * Hermes serves `GET /v1/runs/{id}/events` for both live and finished runs:
 * a finished run replays from the Gate's archive, a live run proxies the
 * ongoing stream. `loadEvents` abstracts the call so the sheet does not depend
 * on the gateway context, and the abort signal stops the collection as soon as
 * the sheet closes — no background drain. The failed-replay path renders the
 * exact `formatRunFailure` line every other run failure shows so an operator
 * who reaches for the transcript on a stale run sees the same verdict the
 * activity card would.
 */
export function AgenticRunSheet({ runId, loadEvents, onClose }: AgenticRunSheetProps) {
  const [events, setEvents] = useState<RunEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const cancelled = useRef(false);

  const fetch = useCallback(
    async (id: string) => {
      const controller = new AbortController();
      controllerRef.current = controller;
      cancelled.current = false;
      try {
        const list = await loadEvents(id, controller.signal);
        if (cancelled.current) return;
        setEvents(list);
        setError(null);
      } catch (caught) {
        if (cancelled.current) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        setEvents(null);
        setError(message);
      } finally {
        // Aborting on success too is safe: by the time `loadEvents` resolves
        // the SSE stream has already closed end-to-end (the replay ends, the
        // abort does nothing). On failure the abort releases whatever the
        // stream still has open.
        controller.abort();
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [loadEvents],
  );

  // State resets by REMOUNT, not by writing it here: the parent keys this
  // sheet on the run id, so a different run arrives as a fresh component with
  // empty state. Clearing inside the effect would cascade a render and trips
  // react-hooks/set-state-in-effect for exactly that reason.
  useEffect(() => {
    if (!runId) return undefined;
    const tick = setTimeout(() => { void fetch(runId); }, 0);
    return () => {
      cancelled.current = true;
      clearTimeout(tick);
      // A runId swap or an unmount mid-replay must cut the stream: an in-flight
      // replay on a closed sheet is the exact background drain this component
      // exists to avoid.
      controllerRef.current?.abort();
    };
  }, [fetch, runId]);

  if (!runId) return null;

  return (
    <BaseSheet visible onClose={onClose} title="Run transcript" eyebrow="REPLAY">
      <ScrollView contentContainerStyle={styles.body}>
        <Text variant="micro" color="tertiary" selectable>{runId}</Text>
        <Divider />

        {error ? (
          <Text variant="caption" color="statusDisconnected" selectable>
            {formatRunFailure(error) ?? error}
          </Text>
        ) : null}
        {error ? (
          <Button label="Retry" variant="ghost" size="sm" onPress={() => void fetch(runId)} />
        ) : null}

        {events === null && !error ? (
          <>
            <Skeleton width="90%" height={44} />
            <Skeleton width="76%" height={44} style={styles.gap} />
            <Text variant="caption" color="secondary">Loading…</Text>
          </>
        ) : null}

        {events !== null && events.length === 0 && !error ? (
          <Text variant="caption" color="secondary">
            The replay completed without events.
          </Text>
        ) : null}

        {events && events.length > 0 ? (
          <View style={styles.list}>
            {events.map((event, index) => (
              <Text key={index} variant="mono" color="tertiary" style={styles.eventLine}>
                {event.type}: {runEventPreview(event)}
              </Text>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: Spacing.two, paddingBottom: Spacing.five },
  list: { gap: Spacing.one },
  eventLine: { paddingVertical: 1 },
  gap: { marginTop: Spacing.two },
});