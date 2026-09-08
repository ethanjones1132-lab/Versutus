import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BaseSheet, Button, ConfirmSheet, Divider, ListRow, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { haptics } from '@/lib/haptics';
import {
  cronJobPauseLabel,
  describeCronJobControlError,
} from '@/lib/gateway/cron-job-controls';
import {
  describeCronHealth,
  runElapsedLabel,
  type CronJob,
  type CronRun,
} from '@/lib/gateway/cron';

export type CronJobSheetProps = {
  job: CronJob | null;
  onClose: () => void;
  /** Opens one run's transcript; the parent owns that surface. */
  onOpenRun: (runId: string) => void;
  /**
   * Fires after a confirmed, successful remove. The parent uses it to
   * refresh the cron list so the row drops without a remount; the sheet
   * itself only knows about one job at a time.
   */
  onRemoved?: () => void;
  /**
   * Fires after a confirmed, successful Run-now or Pause/Resume. The parent
   * uses it to refresh the cron list so the roster reflects the state the
   * host confirmed; the sheet's own run-history re-read stays local.
   */
  onChanged?: () => void;
};

function Row({ label, value }: { label: string; value?: string | null }) {
  // An absent value reads as unknown, never as an empty confident answer.
  return (
    <View style={styles.field}>
      <Text variant="micro" color="tertiary">{label.toUpperCase()}</Text>
      <Text variant="caption" selectable>{value ?? '—'}</Text>
    </View>
  );
}

/**
 * Everything the host holds about one scheduled job.
 *
 * Curated fields lead, because thirty-six raw ones answer no question quickly.
 * The full prompt and the untouched record sit behind toggles — collapsed by
 * default so a 6,000-character prompt does not bury the schedule, expandable
 * because "show raw" is what makes the curation trustworthy rather than a
 * story the app tells.
 */
export function CronJobSheet({ job, onClose, onOpenRun, onRemoved, onChanged }: CronJobSheetProps) {
  const { botJobs, cron } = useGateway();
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);
  // Whether the first run-history read has landed (success or refusal).
  // The sheet opens with runs=[] before the deferred first read, which is
  // indistinguishable from a genuinely empty history without this flag.
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  // The pause state the host last confirmed. A refused Pause/Resume keeps
  // this, so the label never flips to a state the host did not take.
  const [pausedOverride, setPausedOverride] = useState<boolean | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  // Which job is pending destructive confirmation. null = sheet closed.
  // Snapshotted into a local inside executeRemove so a fast Cancel after
  // Confirm still removes the job the user confirmed, never the empty state.
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const jobId = job?.id ?? null;
  const paused = pausedOverride ?? job?.paused ?? false;
  const loadRuns = useCallback(async () => {
    if (!jobId) return;
    try {
      setRuns(await cron.runs(jobId));
      setRunsError(null);
      setRunsLoaded(true);
    } catch (caught) {
      setRunsError(caught instanceof Error ? caught.message : String(caught));
      setRunsLoaded(true);
    }
  }, [cron, jobId]);

  const submitRun = useCallback(async () => {
    if (!jobId || acting) return;
    setActing(true);
    setControlError(null);
    try {
      await botJobs.run(jobId);
      // The run just started reads back through the same history the sheet
      // renders; without this the new run is missing until a remount.
      await loadRuns();
      onChanged?.();
    } catch (caught) {
      setControlError(describeCronJobControlError(caught));
    } finally {
      setActing(false);
    }
  }, [acting, botJobs, jobId, loadRuns, onChanged]);

  const submitTogglePause = useCallback(async () => {
    if (!jobId || acting) return;
    setActing(true);
    setControlError(null);
    try {
      await botJobs.pause(jobId, !paused);
      setPausedOverride(!paused);
      onChanged?.();
    } catch (caught) {
      setControlError(describeCronJobControlError(caught));
    } finally {
      setActing(false);
    }
  }, [acting, botJobs, jobId, onChanged, paused]);

  // Destructive counterpart to submitRun / submitTogglePause. The Gate
  // dispatches the jobs.remove RPC to removeJob on the resolved backend;
  // a refusal lands in controlError exactly like the run/pause calls so
  // the failed-action path stays uniform (and the sheet stays open so the
  // user can read the failure, retry, or cancel).
  const executeRemove = useCallback(async () => {
    // Snapshot the confirmed target so a fast cancel after Confirm still
    // removes the job the user tapped (and never the empty state).
    const target = removeTarget ?? jobId;
    if (!target || acting) return;
    setActing(true);
    setControlError(null);
    try {
      await botJobs.remove(target);
      setRemoveTarget(null);
      // Tell the parent so its cron list can re-read; the parent owns the
      // sheet mount and is the only thing that can drop the row without
      // a remount.
      onRemoved?.();
    } catch (caught) {
      setControlError(describeCronJobControlError(caught));
      setRemoveTarget(null);
    } finally {
      setActing(false);
    }
  }, [acting, botJobs, jobId, onRemoved, removeTarget]);

  // Keyed by job id upstream, so each job opens as a fresh component with
  // collapsed toggles and no stale run list — no setState in the effect body.
  useEffect(() => {
    if (!jobId) return undefined;
    const timer = setTimeout(() => { void loadRuns(); }, 0);
    return () => clearTimeout(timer);
  }, [jobId, loadRuns]);

  if (!job) return null;
  const health = describeCronHealth(job);

  return (
    <BaseSheet visible onClose={onClose} title={job.title || job.id} eyebrow="SCHEDULED JOB">
      <ScrollView contentContainerStyle={styles.body}>
        <Text variant="caption" color={health.tone === 'error' ? 'statusDisconnected' : 'secondary'}>
          {job.running ? 'Running now' : health.label}
          {health.detail ? ` — ${health.detail}` : ''}
        </Text>

        <View style={styles.controls}>
          <Button
            label={acting ? 'Working…' : 'Run now'}
            variant="ghost"
            size="sm"
            disabled={acting}
            busy={acting}
            onPress={() => void submitRun()}
          />
          <Button
            label={cronJobPauseLabel({ paused })}
            variant="ghost"
            size="sm"
            disabled={acting}
            busy={acting}
            onPress={() => void submitTogglePause()}
          />
          <Button
            label="Remove"
            variant="ghost"
            size="sm"
            disabled={acting}
            accessibilityHint="Opens a confirmation, then removes this scheduled job and stops its run history."
            onPress={() => jobId && setRemoveTarget(jobId)}
          />
        </View>
        {controlError ? (
          <Text variant="caption" color="statusDisconnected" selectable>{controlError}</Text>
        ) : null}

        <ConfirmSheet
          visible={removeTarget !== null}
          title="Remove scheduled job?"
          message={`${job.title || job.id} will be removed from this gateway. Its run history stops here.`}
          confirmLabel="Remove"
          danger
          busy={acting}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => void executeRemove()}
        />

        <Divider />

        <Row label="Schedule" value={job.scheduleDisplay ?? job.schedule} />
        <Row label="Next run" value={job.nextRunAt} />
        <Row label="Last run" value={job.lastRunAt} />
        <Row label="Owner" value={job.botId ? `Bot: ${job.botId}` : 'the gateway itself'} />
        <Row label="Model" value={job.model ?? 'gateway default'} />
        <Row label="Provider" value={job.provider ?? 'gateway default'} />
        <Row label="Toolsets" value={job.toolsets?.length ? job.toolsets.join(', ') : 'none'} />
        <Row label="Workdir" value={job.workdir} />
        <Row label="Delivery" value={job.deliver} />
        <Row label="Origin" value={job.origin} />

        <Divider />

        <Button
          label={showPrompt ? 'Hide prompt' : `Show prompt (${job.promptLength ?? 0} chars)`}
          variant="ghost"
          size="sm"
          expanded={showPrompt}
          onPress={() => setShowPrompt((open) => !open)}
        />
        {showPrompt ? (
          <Text variant="micro" style={styles.mono} selectable>{job.prompt || '—'}</Text>
        ) : null}

        <Button
          label={showRaw ? 'Hide raw record' : 'Show raw record'}
          variant="ghost"
          size="sm"
          expanded={showRaw}
          onPress={() => setShowRaw((open) => !open)}
        />
        {showRaw ? (
          <View style={styles.rawCard}>
            <ScrollView style={styles.rawScroll} nestedScrollEnabled>
              <Text variant="micro" style={styles.mono} selectable>
                {JSON.stringify(job.raw ?? job, null, 2)}
              </Text>
            </ScrollView>
          </View>
        ) : null}

        <Button
          label="Copy job id"
          variant="ghost"
          size="sm"
          onPress={async () => {
            await Clipboard.setStringAsync(job.id);
            await haptics.success();
          }}
        />

        <Divider />

        <Text variant="micro" color="tertiary">RUN HISTORY ({runs.length})</Text>
        {runsError ? (
          <Text variant="caption" color="statusDisconnected" selectable>{runsError}</Text>
        ) : null}
        {runsError ? (
          <Button label="Retry" variant="ghost" size="sm" onPress={() => void loadRuns()} />
        ) : null}
        {!runsError && !runsLoaded ? (
          <>
            <Skeleton width="90%" height={44} />
            <Skeleton width="76%" height={44} style={styles.gap} />
          </>
        ) : null}
        {!runsError && runsLoaded && runs.length === 0 ? (
          <Text variant="caption" color="secondary">No runs recorded yet.</Text>
        ) : null}
        {runs.map((run) => (
          <ListRow
            key={run.id}
            title={run.at ?? run.id}
            subtitle={
              `${run.status === 'running' ? 'running' : 'completed'}` +
              `${runElapsedLabel(run) ? ` · ${runElapsedLabel(run)}` : ''}` +
              ` · ${run.turnCount} turns`
            }
            onPress={() => onOpenRun(run.id)}
            style={styles.row}
          />
        ))}
      </ScrollView>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: Spacing.two, paddingBottom: Spacing.five },
  controls: { flexDirection: 'row', gap: Spacing.two },
  field: { gap: 2 },
  row: { marginBottom: Spacing.one },
  gap: { marginTop: Spacing.two },
  mono: { fontFamily: 'monospace' },
  rawCard: {
    borderWidth: 1,
    borderColor: 'rgba(229, 198, 126, 0.18)',
    borderRadius: 8,
    padding: Spacing.two,
  },
  rawScroll: {
    maxHeight: 200,
  },
});
