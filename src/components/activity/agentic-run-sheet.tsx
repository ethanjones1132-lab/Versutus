import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BaseSheet, Button, Divider, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { formatRunFailure } from '@/lib/gateway/run-failures';
import { runEventPreview, type RunTranscriptPage } from '@/lib/gateway/runs';
import type { RunEvent } from '@/lib/gateway/types';
import { sheetMaxHeight } from '@/lib/motion/sheet-height';

export type AgenticRunSheetProps = {
  /** The run's id; null renders nothing (sheet dismissed). */
  runId: string | null;
  /**
   * Single-shot reader: subscribes to the gateway's replay stream and resolves
   * with the newest window (or a bare array from a showcase client).
   */
  loadEvents: (runId: string, signal: AbortSignal) => Promise<RunEvent[] | RunTranscriptPage>;
  onClose: () => void;
};

/**
 * Grab handle + header + title + content pad inside BaseSheet. The list's
 * maxHeight has to leave this standing or the sheet overflows; the run id
 * and divider live in the list header, so they are not in this number.
 * grab (~12) + header (~46) + title (~44) + content pad (~8) ≈ 110.
 */
export const TRANSCRIPT_LIST_CHROME = 110;
export const TRANSCRIPT_LIST_MIN_HEIGHT = 120;

/**
 * Remaining sheet body for the transcript list. No 380 cap: this list *is*
 * the sheet body, so a long replay still fills the sheet the way the old
 * ScrollView did. The bound is what lets FlatList window on a phone;
 * without it the list grows to its content and mounts every row.
 */
export function transcriptListMaxHeight(input: {
  windowHeight: number;
  insetTop?: number;
  insetBottom?: number;
  keyboardHeight?: number;
}): number {
  const sheet = sheetMaxHeight({
    windowHeight: input.windowHeight,
    insetTop: input.insetTop,
    insetBottom: input.insetBottom,
    keyboardHeight: input.keyboardHeight,
  });
  return Math.max(TRANSCRIPT_LIST_MIN_HEIGHT, Math.round(sheet - TRANSCRIPT_LIST_CHROME));
}

function pageFromLoad(result: RunEvent[] | RunTranscriptPage): RunTranscriptPage {
  if (Array.isArray(result)) return { events: result, omitted: 0 };
  return result;
}

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
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const listMaxHeight = transcriptListMaxHeight({
    windowHeight,
    insetTop: insets.top,
    insetBottom: insets.bottom,
  });
  const [events, setEvents] = useState<RunEvent[] | null>(null);
  const [omitted, setOmitted] = useState(0);
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
        const page = pageFromLoad(list);
        setEvents(page.events);
        setOmitted(page.omitted);
        setError(null);
      } catch (caught) {
        if (cancelled.current) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        setEvents(null);
        setOmitted(0);
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

  // One line per event, exactly as before. The list windows the rows rather
  // than mapping them: the Gate serves a finished run's replay from a per-run
  // SSE file capped at 8 MiB, which is tens of thousands of frames, and mounting
  // every one of them as a <Text> in a ScrollView froze the JS thread for
  // seconds on a mid-range phone.
  const renderEvent = useCallback(({ item: event }: { item: RunEvent }) => (
    <Text variant="mono" color="tertiary" style={styles.eventLine}>
      {event.type}: {runEventPreview(event)}
    </Text>
  ), []);

  if (!runId) return null;

  return (
    <BaseSheet visible onClose={onClose} title="Run transcript" eyebrow="REPLAY">
      <FlatList
        data={events ?? []}
        keyExtractor={(_event, index) => String(index)}
        renderItem={renderEvent}
        style={[styles.list, { maxHeight: listMaxHeight }]}
        // The fixed top half is not a row: the run id, the divider, the verdict
        // and its retry, and the loading pair. The sheet body no longer scrolls
        // as one block, so the list owns the scroll.
        ListHeaderComponent={
          <View style={styles.head}>
            <Text variant="micro" color="tertiary" selectable>{runId}</Text>
            <Divider />

            {omitted > 0 ? (
              <Text variant="caption" color="secondary">
                {omitted} earlier events not shown.
              </Text>
            ) : null}

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
          </View>
        }
        ListEmptyComponent={
          events !== null && !error ? (
            <Text variant="caption" color="secondary">
              The replay completed without events.
            </Text>
          ) : null
        }
        ItemSeparatorComponent={() => <View style={styles.eventGap} />}
        contentContainerStyle={styles.body}
        initialNumToRender={12}
        maxToRenderPerBatch={16}
        windowSize={9}
        removeClippedSubviews
      />
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 0 },
  body: { paddingBottom: Spacing.five },
  // `head` carries the gap the body container used to: the header is one cell of
  // the list, and the events are rows, so the space between the header and the
  // first line has to come from here for the sheet to read exactly as it did.
  head: { gap: Spacing.two, paddingBottom: Spacing.two },
  eventGap: { height: Spacing.one },
  eventLine: { paddingVertical: 1 },
  gap: { marginTop: Spacing.two },
});