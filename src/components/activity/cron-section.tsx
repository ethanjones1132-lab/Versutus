import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { CronJobSheet } from '@/components/activity/cron-job-sheet';
import { CronRunSheet } from '@/components/activity/cron-run-sheet';
import { Badge, Button, Card, EmptyState, ErrorCard, ListRow, Skeleton, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  cronJobSummary,
  describeCronHealth,
  runningCount,
  sortCronJobs,
  type CronJob,
} from '@/lib/gateway/cron';
import { canCreateGatewayJob, gatewayJobInput } from '@/lib/gateway/cron-create';
import { applyRoutineCreate, DEFAULT_ROUTINE_SCHEDULE } from '@/lib/gateway/routines';

import type { TextColor } from '@/components/ui/types';

const TONE_COLOR: Record<ReturnType<typeof describeCronHealth>['tone'], TextColor> = {
  ok: 'statusConnected',
  warn: 'accentWarm',
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

  const available = cron.available;

  const load = useCallback(async () => {
    if (status !== 'connected' || !available) {
      setLoaded(true);
      return;
    }
    try {
      setJobs(await cron.list());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoaded(true);
    }
  }, [available, cron, status]);

  useEffect(() => {
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

  const sorted = sortCronJobs(jobs);
  const live = runningCount(jobs);

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <View style={styles.header}>
        <Text variant="title">Cron ({jobs.length})</Text>
        {live > 0 ? <Badge label={`${live} running`} tone="accent" /> : null}
      </View>

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

      {sorted.map((job) => {
        const health = describeCronHealth(job);
        return (
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
          />
        );
      })}

      <Text variant="micro" color="secondary">
        New scheduled job
      </Text>
      {createError ? (
        <Text variant="caption" color="accentWarm">
          {createError}
        </Text>
      ) : null}
      <TextField value={title} onChangeText={setTitle} placeholder="Overnight mail summary" />
      <TextField value={schedule} onChangeText={setSchedule} placeholder={DEFAULT_ROUTINE_SCHEDULE} />
      <TextField value={prompt} onChangeText={setPrompt} placeholder="Summarize overnight mail" multiline />
      <Button
        label={creating ? 'Adding…' : 'Add'}
        disabled={creating || !canCreateGatewayJob({ title, prompt, schedule })}
        onPress={submitCreate}
      />

      <CronJobSheet
        key={openJob?.id ?? 'no-job'}
        job={openJob}
        onClose={() => setOpenJob(null)}
        onOpenRun={(runId) => {
          setOpenJob(null);
          setOpenRunId(runId);
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
