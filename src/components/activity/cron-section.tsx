import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useFocusEffect } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { CronJobSheet } from '@/components/activity/cron-job-sheet';
import { CronRunSheet } from '@/components/activity/cron-run-sheet';
import { Badge, Button, Card, EmptyState, ErrorCard, ListRow, Skeleton, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  cronJobSummary,
  cronListSummaryText,
  describeCronHealth,
  filterCronJobsByTitle,
  groupCronJobsByOwner,
  runningCount,
  sortCronJobs,
  type CronJob,
} from '@/lib/gateway/cron';
import { canCreateGatewayJob, gatewayJobInput } from '@/lib/gateway/cron-create';
import { applyRoutineCreate, DEFAULT_ROUTINE_SCHEDULE } from '@/lib/gateway/routines';

import type { TextColor } from '@/components/ui/types';

const TONE_COLOR: Record<ReturnType<typeof describeCronHealth>['tone'], TextColor> = {
  ok: 'statusConnected',
  warn: 'statusConnecting',
  error: 'statusDisconnected',
  off: 'tertiary',
  unknown: 'secondary',
};

/**
 * Every scheduled job on the gateway, with a way into its config and the
 * transcript of any run.
 *
 * Renders nothing at all when the gateway cannot join jobs to their runs. An
 * empty list on a host with twelve crons would read as "no scheduled work",
 * which is a worse lie than saying nothing.
 */
export function CronSection({ cronReloadSignal = 0 }: { cronReloadSignal?: number }) {
  const { botJobs, cron, status } = useGateway();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [openJob, setOpenJob] = useState<CronJob | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [schedule, setSchedule] = useState(DEFAULT_ROUTINE_SCHEDULE);
  const [createError, setCreateError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  // The list can outgrow one screen: a title filter over what the section
  // already holds, client-side, applied before the owner grouping. No empty
  // query means no fold ran differently — the idle field is a no-op.
  const [titleFilter, setTitleFilter] = useState('');

  const available = cron.available;

  // One read at a time. Two callers asking in the same tick — the focus read
  // and a pull-to-refresh's reload signal — used to issue two `cron.list()`
  // calls for the same list, and a Gate that serves one request at a time has
  // to answer both. The second caller now JOINS the read in flight; `settled`
  // is what keeps a caller arriving in the same turn a read answers in from
  // joining one that has already finished.
  const inFlight = useRef<{ settled: boolean; promise: Promise<void> } | null>(null);
  // Which read owns the rows on screen. A slow read that a newer one has
  // superseded must not paint: its list is older than what the operator just
  // did (a job paused, run or removed since it went out).
  const requestId = useRef(0);

  const load = useCallback((): Promise<void> => {
    const running = inFlight.current;
    if (running && !running.settled) return running.promise;
    const id = ++requestId.current;
    const ticket = { settled: false, promise: Promise.resolve() };
    inFlight.current = ticket;
    ticket.promise = (async () => {
      try {
        if (status !== 'connected' || !available) {
          setLoaded(true);
          return;
        }
        try {
          const next = await cron.list();
          if (id !== requestId.current) return;
          setJobs(next);
          setError(null);
        } catch (caught) {
          if (id !== requestId.current) return;
          setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          if (id === requestId.current) setLoaded(true);
        }
      } finally {
        // Released on both outcomes, so a refused read never wedges the section
        // against every later read.
        ticket.settled = true;
        if (inFlight.current === ticket) inFlight.current = null;
      }
    })();
    return ticket.promise;
  }, [available, cron, status]);

  // The focus effect below already reads on the first focus, so this one must
  // not repeat it — two `cron.list()` calls in the same tick is the duplicate
  // this file exists without. It is here for the pull's reload signal, and
  // only for changes to that signal after the first read.
  const mountedSignal = useRef(cronReloadSignal);
  useEffect(() => {
    if (cronReloadSignal === mountedSignal.current) return undefined;
    mountedSignal.current = cronReloadSignal;
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load, cronReloadSignal]);

  // Re-read jobs when the operator returns to the tab: a Routine that
  // starts or finishes while Activity is backgrounded keeps its old verdict
  // (running badge / Not running) until the next connection cycle otherwise.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // Gateway-level create through the existing job client: the title goes out
  // raw, never `[bot:…]`-prefixed, so the Gate files a gateway-level job
  // instead of one Bot's Routine. Fail honest like the Routines pane — a
  // refusal keeps the draft and names why; only a confirmed create clears it.
  const submitCreate = () => {
    const submitted = {
      title: title.trim(),
      prompt: prompt.trim(),
      schedule: schedule.trim() || DEFAULT_ROUTINE_SCHEDULE,
    };
    if (!submitted.title || !submitted.prompt || creating) return;
    setCreating(true);
    setCreateError(undefined);
    void Promise.resolve(botJobs.create(gatewayJobInput(submitted)))
      .then(() => {
        const next = applyRoutineCreate(submitted, { ok: true });
        setTitle(next.draft.title);
        setPrompt(next.draft.prompt);
        setSchedule(next.draft.schedule);
        // No phone-side notice, and none is possible: a routine notice is
        // Bot-bound by design (it opens that Bot's chat), and this form files a
        // gateway-level job whose unprefixed title names no Bot — so the sync
        // would withhold the notice and retire any held one. The job still runs
        // on the gateway and its roster still shows it.
        void load();
      })
      .catch((cause: unknown) => {
        const next = applyRoutineCreate(submitted, { ok: false, cause });
        setTitle(next.draft.title);
        setPrompt(next.draft.prompt);
        setSchedule(next.draft.schedule);
        setCreateError(next.error);
      })
      .finally(() => setCreating(false));
  };

  if (status !== 'connected' || !available) return null;

  // An idle filter field leaves the sorted list byte-identical (the fold answers
  // the same array for an empty query); a query narrows `sorted` itself, so the
  // owner grouping and every row below read one narrowed list.
  const base = sortCronJobs(jobs);
  const sorted =
    titleFilter.trim().length > 0 ? filterCronJobsByTitle(base, titleFilter) : base;
  const live = runningCount(jobs);

  return (
    <Card variant="stage" padding={Spacing.three} style={styles.card}>
      <View style={styles.header}>
        <Text variant="headline">Cron ({jobs.length})</Text>
        {live > 0 ? <Badge label={`${live} running`} tone="accent" /> : null}
      </View>

      {/* The section's own health mix, on the line under the header: null when
          every job is ok, so a clean list renders exactly as it did before. */}
      {(() => {
        const summary = cronListSummaryText(jobs);
        return summary ? (
          <Text variant="micro" color="secondary">
            {summary}
          </Text>
        ) : null;
      })()}

      {error ? (
        <ErrorCard
          cause={error}
          affected="Scheduled work on this gateway"
          next="Retry, or check the cron environment on the Gate machine."
          onRetry={() => void load()}
        />
      ) : null}

      {!loaded ? (
        <>
          <Skeleton width="90%" height={44} />
          <Skeleton width="76%" height={44} style={styles.gap} />
        </>
      ) : null}

      {loaded && !error && jobs.length === 0 ? (
        <EmptyState
          icon={{ ios: 'clock', android: 'schedule', web: 'schedule' }}
          title="No scheduled work on this gateway"
          description="File scheduled work with the New scheduled job form below."
        />
      ) : null}

      {(() => {
        // One owner / all-unowned renders exactly as before; multiple owners
        // get a micro heading per Bot, unowned under "Gateway" (a job whose
        // name carries no Bot is attributed to nobody, not guessed).
        const groups = groupCronJobsByOwner(sorted);
        const needsHeadings = [...groups.keys()].filter(Boolean).length > 1;
        const rows: ReactNode[] = [];
        // The filter field rides the group render so an idle field changes
        // nothing below: the empty query answers the list the section holds.
        if (jobs.length > 3) {
          rows.push(
            <View key="cron-filter" style={styles.gap}>
              <TextField
                value={titleFilter}
                onChangeText={setTitleFilter}
                placeholder="Filter by title"
                accessibilityLabel="Filter scheduled work by title"
                autoCapitalize="none"
              />
              {titleFilter.trim().length > 0 ? (
                <View style={styles.header}>
                  <Text variant="micro" color="secondary">
                    {sorted.length} of {jobs.length} jobs
                  </Text>
                  <Button label="Clear" variant="ghost" size="sm" onPress={() => setTitleFilter('')} />
                </View>
              ) : null}
            </View>,
          );
        }
        for (const [botId, group] of groups) {
          if (needsHeadings) {
            rows.push(
              <Text key={`own:${botId ?? 'gateway'}`} variant="micro" color="secondary">
                {botId ? `Bot ${botId}` : 'Gateway'}
              </Text>,
            );
          }
          for (const job of group) {
            const health = describeCronHealth(job);
            rows.push(
              <ListRow
                key={job.id}
                title={job.title || job.id}
                subtitle={cronJobSummary(job)}
                onPress={() => setOpenJob(job)}
                trailing={
                  <Text variant="micro" color={TONE_COLOR[health.tone]}>
                    {job.running ? '●' : health.label}
                  </Text>
                }
                style={styles.row}
              />,
            );
          }
        }
        return rows;
      })()}

      <Text variant="micro" color="secondary">
        New scheduled job
      </Text>
      {createError ? (
        <Text variant="caption" color="statusDisconnected">
          {createError}
        </Text>
      ) : null}
      <TextField value={title} onChangeText={setTitle} placeholder="Overnight mail summary" />
      <TextField value={schedule} onChangeText={setSchedule} placeholder={DEFAULT_ROUTINE_SCHEDULE} />
      <TextField value={prompt} onChangeText={setPrompt} placeholder="Summarize overnight mail" multiline />
      <Button
        label={creating ? 'Adding…' : 'Add'}
        disabled={creating || !canCreateGatewayJob({ title, prompt, schedule })}
        busy={creating}
        onPress={submitCreate}
      />

      <CronJobSheet
        key={openJob?.id ?? 'no-job'}
        // Hide while a run transcript is open so two BaseSheets do not stack;
        // the job stays in state and closing the run restores RUN HISTORY.
        job={openRunId ? null : openJob}
        onClose={() => setOpenJob(null)}
        onOpenRun={(runId) => {
          setOpenRunId(runId);
        }}
        onRemoved={() => {
          // Drop the now-removed row without a remount: close the sheet
          // (the open job no longer exists on the gateway) and re-read the
          // job list so the parent's cron roster reflects the deletion.
          setOpenJob(null);
          void load();
        }}
        onChanged={() => {
          // A confirmed Run-now or Pause/Resume changed the roster the
          // parent renders; re-read so the row reflects the host state.
          void load();
        }}
      />
      <CronRunSheet key={openRunId ?? 'no-run'} runId={openRunId} onClose={() => setOpenRunId(null)} />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  row: { marginBottom: Spacing.one },
  gap: { marginTop: Spacing.two },
});
