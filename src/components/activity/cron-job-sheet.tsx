import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BaseSheet, Button, ConfirmSheet, Divider, ErrorCard, ListRow, Skeleton, Text, TextField } from '@/components/ui';
import { Palette, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import type { RoutineScope } from '@/lib/gateway/activity-feed';
import { haptics } from '@/lib/haptics';
import {
  cronJobPauseLabel,
  describeCronJobControlError,
} from '@/lib/gateway/cron-job-controls';
import {
  cronRunSummary,
  cronJobOriginText,
  describeCronHealth,
  type CronJob,
  type CronRun,
} from '@/lib/gateway/cron';
import { formatRunFailure } from '@/lib/gateway/run-failures';
import { parseRoutineName, routineName } from '@/lib/gateway/routine-name';
import { routineScheduleView } from '@/lib/routines/schedule';
// The phone-side scheduled notice a cron string maps to; a confirmed
// pause/resume or remove keeps it in step (fire-and-forget, best-effort).
import {
  cancelRoutineNotification,
  syncRoutineNotification,
} from '@/lib/notifications/routine-sync';

export type CronJobSheetProps = {
  job: CronJob | null;
  /**
   * The environment that owns this job. Activity's routines carry one; a job
   * opened from the default roster names none and keeps every call as it was.
   */
  backendId?: string;
  /** Exact owner carried by an Activity routine row; null Bot explicitly means backend root. */
  scope?: RoutineScope;
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

function executionField(execution: CronJob['latestExecution'], ...keys: string[]): string | null {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) return null;
  for (const key of keys) {
    const value = execution[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function executionError(execution: CronJob['latestExecution']): string | null {
  if (!isRecord(execution)) return null;
  const error = execution.error;
  if (error === null) return 'none recorded';
  // A present error this build cannot read stays unknown rather than being
  // dressed up as "none recorded".
  if (typeof error !== 'string') return null;
  const raw = error.trim();
  if (!raw) return 'none recorded';
  // The same classifier chat failures use (VS-127): a host state this build
  // knows gets its verdict and fix, and text it does not know stays verbatim.
  return formatRunFailure(raw) ?? raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function executionKey(job: CronJob | null): string | null {
  return executionField(job?.latestExecution, 'id', 'started_at', 'startedAt');
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
export function CronJobSheet({ job, backendId, scope, onClose, onOpenRun, onRemoved, onChanged }: CronJobSheetProps) {
  const { botJobs, cron } = useGateway();
  const jobId = job?.id ?? null;
  const detailIdentity = JSON.stringify([
    jobId,
    backendId?.trim() || null,
    scope?.backendId?.trim() || null,
    scope?.botId?.trim() || null,
  ]);
  const detailReadSequence = useRef(0);
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);
  // Whether the first run-history read has landed (success or refusal).
  // The sheet opens with runs=[] before the deferred first read, which is
  // indistinguishable from a genuinely empty history without this flag.
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [fullDetail, setFullDetail] = useState<{ identity: string; job: CronJob } | null>(null);
  const [detailRead, setDetailRead] = useState<{
    identity: string;
    phase: 'loading' | 'ready' | 'failed' | 'unavailable';
    error: string | null;
  }>({ identity: detailIdentity, phase: 'loading', error: null });
  const [controlError, setControlError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const actionBusy = useRef(false);
  const [requestedRun, setRequestedRun] = useState<{ identity: string; previous: string | null } | null>(null);
  // The pause state the host last confirmed. A refused Pause/Resume keeps
  // this, so the label never flips to a state the host did not take.
  const [pausedOverride, setPausedOverride] = useState<boolean | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editRefreshNote, setEditRefreshNote] = useState<string | null>(null);
  const [editDetail, setEditDetail] = useState<CronJob | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editSchedule, setEditSchedule] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  // Which job is pending destructive confirmation. null = sheet closed.
  // Snapshotted into a local inside executeRemove so a fast Cancel after
  // Confirm still removes the job the user confirmed, never the empty state.
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  // Activity names the environment that owns the routine it opened. A sheet
  // mounted from the default roster passes none, and every call below then
  // keeps today's exact shape (no second/third argument).
  const namedBackend = backendId?.trim() || undefined;
  const actionScope = scope ?? namedBackend;
  const canEdit = Boolean(job && scope?.backendId?.trim() && botJobs.canUpdate?.(scope) && cron.list);
  const hasExplicitScope = scope !== undefined;
  const scopeBackendId = scope?.backendId;
  const scopeBotId = scope?.botId;
  const detailScope = useMemo<RoutineScope | undefined>(
    () => hasExplicitScope
      ? { backendId: scopeBackendId, botId: scopeBotId }
      : namedBackend
        ? { backendId: namedBackend }
        : undefined,
    [hasExplicitScope, namedBackend, scopeBackendId, scopeBotId],
  );

  const readJobDetail = useCallback(async (): Promise<CronJob | null> => {
    if (!jobId) return null;
    if (typeof cron.list !== 'function') {
      setDetailRead({ identity: detailIdentity, phase: 'unavailable', error: null });
      return null;
    }

    const sequence = ++detailReadSequence.current;
    setDetailRead({ identity: detailIdentity, phase: 'loading', error: null });
    try {
      const jobs = detailScope ? await cron.list(detailScope) : await cron.list();
      if (sequence !== detailReadSequence.current) return null;
      const detail = jobs.find((candidate) => candidate.id === jobId);
      if (!detail) {
        const error = 'The gateway did not return this routine’s full details.';
        setDetailRead({ identity: detailIdentity, phase: 'failed', error });
        return null;
      }
      setFullDetail({ identity: detailIdentity, job: detail });
      setPausedOverride((current) => current === detail.paused ? null : current);
      const latest = executionKey(detail);
      setRequestedRun((current) => current?.identity === detailIdentity && latest && latest !== current.previous ? null : current);
      setDetailRead({ identity: detailIdentity, phase: 'ready', error: null });
      return detail;
    } catch (caught) {
      if (sequence !== detailReadSequence.current) return null;
      const error = caught instanceof Error ? caught.message : String(caught);
      setDetailRead({ identity: detailIdentity, phase: 'failed', error });
      return null;
    }
  }, [cron, detailIdentity, detailScope, jobId]);

  const loadRuns = useCallback(async () => {
    if (!jobId) return;
    try {
      const nextRuns = actionScope ? await cron.runs(jobId, actionScope) : await cron.runs(jobId);
      setRuns(nextRuns);
      setRunsError(null);
      setRunsLoaded(true);
    } catch (caught) {
      setRunsError(caught instanceof Error ? caught.message : String(caught));
      setRunsLoaded(true);
    }
  }, [actionScope, cron, jobId]);

  useEffect(() => {
    if (!jobId) return undefined;
    const timer = setTimeout(() => { void readJobDetail(); }, 0);
    return () => {
      clearTimeout(timer);
      detailReadSequence.current += 1;
    };
  }, [jobId, readJobDetail]);

  const matchingFullDetail = fullDetail?.identity === detailIdentity ? fullDetail.job : null;
  const paused = pausedOverride ?? matchingFullDetail?.paused ?? job?.paused ?? false;
  const currentDetailRead = detailRead.identity === detailIdentity
    ? detailRead
    : { identity: detailIdentity, phase: 'loading' as const, error: null };

  const submitRun = useCallback(async () => {
    if (!jobId || actionBusy.current) return;
    actionBusy.current = true;
    setActing(true);
    setControlError(null);
    try {
      if (actionScope) {
        await botJobs.run(jobId, actionScope);
      } else {
        await botJobs.run(jobId);
      }
      setPausedOverride(null);
      setRequestedRun({ identity: detailIdentity, previous: executionKey(matchingFullDetail ?? job) });
      // Acceptance queues a run; only a later host read can confirm a start.
      // A large transcript catalogue must not delay that acknowledgement.
      void readJobDetail();
      void loadRuns();
      onChanged?.();
    } catch (caught) {
      setControlError(describeCronJobControlError(caught));
    } finally {
      actionBusy.current = false;
      setActing(false);
    }
  }, [actionScope, botJobs, detailIdentity, job, jobId, loadRuns, matchingFullDetail, onChanged, readJobDetail]);

  const submitTogglePause = useCallback(async () => {
    if (!jobId || actionBusy.current) return;
    actionBusy.current = true;
    setActing(true);
    setControlError(null);
    try {
      if (actionScope) {
        await botJobs.pause(jobId, !paused, actionScope);
      } else {
        await botJobs.pause(jobId, !paused);
      }
      setPausedOverride(!paused);
      // Rebuild a reminder only from the schedule the host reads back.
      // Read/notification failure cannot turn an accepted write into refusal.
      if (paused) {
        void readJobDetail().then((fresh) => {
          if (!fresh || fresh.paused !== false) return;
          void syncRoutineNotification({
            id: jobId,
            name: fresh.name ?? undefined,
            schedule: fresh.schedule ?? undefined,
            nextRunAt: fresh.nextRunAt ?? undefined,
            paused: false,
          });
        });
      } else {
        void cancelRoutineNotification(jobId);
        void readJobDetail();
      }
      onChanged?.();
    } catch (caught) {
      setControlError(describeCronJobControlError(caught));
    } finally {
      actionBusy.current = false;
      setActing(false);
    }
  }, [actionScope, botJobs, jobId, onChanged, paused, readJobDetail]);

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
      if (actionScope) {
        await botJobs.remove(target, actionScope);
      } else {
        await botJobs.remove(target);
      }
      setRemoveTarget(null);
      // Stop the phone-side notice too: the job no longer exists on the
      // gateway, so its schedule must not outlive it. Fire-and-forget.
      void cancelRoutineNotification(target);
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
  }, [actionScope, acting, botJobs, jobId, onRemoved, removeTarget]);

  const beginEdit = useCallback(async () => {
    if (!jobId || !scope || !canEdit || editLoading || editSaving) return;
    setEditing(true);
    setEditLoading(true);
    setEditError(null);
    setEditRefreshNote(null);
    setEditDetail(null);
    try {
      const detail = currentDetailRead.phase === 'ready' && matchingFullDetail
        ? matchingFullDetail
        : await readJobDetail();
      if (!detail) {
        setEditError('The gateway did not return this routine, so it cannot be edited safely. Retry the read.');
        return;
      }
      if (typeof detail.name !== 'string' || typeof detail.schedule !== 'string' || typeof detail.prompt !== 'string') {
        setEditError('The gateway did not return the routine name, schedule, and prompt. Retry the read.');
        return;
      }
      setEditDetail(detail);
      setEditTitle(parseRoutineName(detail.name).title);
      setEditSchedule(detail.schedule);
      setEditPrompt(detail.prompt);
    } catch (caught) {
      setEditError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setEditLoading(false);
    }
  }, [canEdit, currentDetailRead.phase, editLoading, editSaving, jobId, matchingFullDetail, readJobDetail, scope]);

  const submitEdit = useCallback(async () => {
    if (!jobId || !scope || !editDetail || editSaving) return;
    const title = editTitle.trim();
    const schedule = editSchedule.trim();
    if (!title || !schedule) return;
    const input = {
      name: editDetail.botId ? routineName(editDetail.botId, title) : title,
      schedule,
      prompt: editPrompt,
    };
    setEditSaving(true);
    setEditError(null);
    try {
      await botJobs.update(jobId, input, scope);
    } catch (caught) {
      // Keep the draft intact so a refused write can be fixed and retried.
      setEditError(describeCronJobControlError(caught));
      setEditSaving(false);
      return;
    }

    // The write landed. Until the scheduler reports its new next run and
    // display string, show the saved expression and no stale next-run claim.
    const savedDraft: CronJob = {
      ...editDetail,
      ...input,
      title,
      promptLength: input.prompt.length,
      scheduleDisplay: null,
      nextRunAt: null,
      raw: undefined,
    };
    setFullDetail({ identity: detailIdentity, job: savedDraft });
    setEditDetail(savedDraft);
    try {
      const jobs = await cron.list(scope);
      const refreshed = jobs.find((candidate) => candidate.id === jobId);
      if (
        refreshed?.name === input.name &&
        refreshed.prompt === input.prompt &&
        refreshed.schedule === input.schedule
      ) {
        setFullDetail({ identity: detailIdentity, job: refreshed });
        setEditDetail(refreshed);
      } else {
        setEditDetail(savedDraft);
        setEditRefreshNote('Saved. The gateway did not confirm the updated schedule display or next run; showing the saved schedule expression.');
      }
    } catch {
      setEditDetail(savedDraft);
      setEditRefreshNote('Saved. The gateway did not confirm the updated schedule display or next run; showing the saved schedule expression.');
    } finally {
      setEditing(false);
      setEditSaving(false);
      onChanged?.();
    }
  }, [botJobs, cron, detailIdentity, editDetail, editPrompt, editSaving, editSchedule, editTitle, jobId, onChanged, scope]);

  // Keyed by job id upstream, so each job opens as a fresh component with
  // collapsed toggles and no stale run list — no setState in the effect body.
  useEffect(() => {
    if (!jobId) return undefined;
    const timer = setTimeout(() => { void loadRuns(); }, 0);
    return () => clearTimeout(timer);
  }, [jobId, loadRuns]);

  if (!job) return null;
  const displayedJobSource = editing && editDetail ? editDetail : matchingFullDetail ?? job;
  // The feed row proves the owner from its Bot home even when Hermes' full
  // record name is unprefixed. Use that proof for display only; editDetail
  // itself stays raw so saving does not invent a `[bot:]` name prefix.
  const displayOwnerBotId = [displayedJobSource.botId, job.botId, scope?.botId].find(
    (botId): botId is string => typeof botId === 'string' && botId.trim().length > 0,
  )?.trim();
  const ownedJob =
    displayOwnerBotId && !displayedJobSource.botId
      ? { ...displayedJobSource, botId: displayOwnerBotId }
      : displayedJobSource;
  const displayedJob = pausedOverride === null ? ownedJob : { ...ownedJob, paused: pausedOverride };
  const scheduleView = routineScheduleView(displayedJob);
  const health = describeCronHealth(displayedJob);
  const promptLength =
    displayedJob.promptLength ?? (typeof displayedJob.prompt === 'string' ? displayedJob.prompt.length : null);

  return (
    <BaseSheet visible onClose={onClose} title={displayedJob.title || displayedJob.id} eyebrow="SCHEDULED JOB">
      <ScrollView contentContainerStyle={styles.body}>
        <Text variant="caption" color={health.tone === 'error' ? 'statusDisconnected' : 'secondary'}>
          {displayedJob.running ? 'Running now' : health.label}
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
          {canEdit && !editing ? (
            <Button
              label="Edit"
              variant="ghost"
              size="sm"
              disabled={acting || editSaving}
              onPress={() => void beginEdit()}
            />
          ) : null}
        </View>
        <Button
          label="Refresh details"
          variant="ghost"
          size="sm"
          disabled={currentDetailRead.phase === 'loading'}
          onPress={() => { void readJobDetail(); void loadRuns(); }}
        />
        {requestedRun?.identity === detailIdentity ? (
          <Text variant="caption" color="secondary">
            Run requested. Refresh details to check whether the gateway has started it.
          </Text>
        ) : null}
        {controlError ? (
          <Text variant="caption" color="statusDisconnected" selectable>{controlError}</Text>
        ) : null}
        {editRefreshNote ? (
          <Text variant="caption" color="tertiary" selectable>{editRefreshNote}</Text>
        ) : null}

        {currentDetailRead.phase === 'loading' ? (
          <Text variant="caption" color="tertiary">
            {matchingFullDetail ? 'Refreshing routine details…' : 'Loading routine details…'}
          </Text>
        ) : null}
        {currentDetailRead.phase === 'failed' ? (
          <ErrorCard
            cause={currentDetailRead.error ?? 'Routine details could not be read.'}
            affected="The routine details"
            next="Try loading the details again."
            retryLabel="Retry routine details"
            onRetry={() => void readJobDetail()}
          />
        ) : null}
        {currentDetailRead.phase === 'unavailable' ? (
          <Text variant="caption" color="tertiary">
            Full routine details are not available from this gateway.
          </Text>
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

        {editing ? (
          <View style={styles.editor}>
            <Text variant="micro" color="secondary">EDIT ROUTINE</Text>
            {editLoading ? <Skeleton width="90%" height={44} /> : null}
            {editError ? <Text variant="caption" color="statusDisconnected" selectable>{editError}</Text> : null}
            {!editLoading && editDetail ? (
              <>
                <TextField value={editTitle} onChangeText={setEditTitle} placeholder="Routine name" accessibilityLabel="Routine name" editable={!editSaving} />
                <TextField value={editSchedule} onChangeText={setEditSchedule} placeholder="Schedule" accessibilityLabel="Schedule" editable={!editSaving} />
                <TextField value={editPrompt} onChangeText={setEditPrompt} placeholder="Prompt" accessibilityLabel="Prompt" multiline editable={!editSaving} />
                <Button
                  label={editSaving ? 'Saving…' : 'Save changes'}
                  variant="primary"
                  size="sm"
                  disabled={editSaving || !editTitle.trim() || !editSchedule.trim()}
                  busy={editSaving}
                  onPress={() => void submitEdit()}
                />
              </>
            ) : null}
            {!editLoading && !editDetail && editError ? (
              <Button label="Retry edit read" variant="ghost" size="sm" onPress={() => void beginEdit()} />
            ) : null}
            <Button
              label="Cancel edit"
              variant="ghost"
              size="sm"
              disabled={editSaving}
              onPress={() => {
                setEditing(false);
                setEditDetail(null);
                setEditError(null);
              }}
            />
          </View>
        ) : null}

        <Divider />

        <Row label="Schedule" value={scheduleView.description} />
        <Row label="Next run" value={displayedJob.paused ? 'Paused' : scheduleView.nextRun} />
        <Row label="Last run" value={displayedJob.lastRunAt} />
        <Row label="Owner" value={displayedJob.botId ? `Bot: ${displayedJob.botId}` : 'the gateway itself'} />
        <Row label="Model" value={displayedJob.model ?? 'gateway default'} />
        <Row label="Provider" value={displayedJob.provider ?? 'gateway default'} />
        <Row label="Toolsets" value={displayedJob.toolsets?.length ? displayedJob.toolsets.join(', ') : 'none'} />
        <Row label="Workdir" value={displayedJob.workdir} />
        <Row label="Delivery" value={displayedJob.deliver} />
        <Row label="Origin" value={cronJobOriginText(displayedJob.origin)} />

        <Divider />

        <Text variant="micro" color="tertiary">LATEST RUN</Text>
        {currentDetailRead.phase === 'loading' && !matchingFullDetail ? (
          <Text variant="caption" color="tertiary">Checking latest run…</Text>
        ) : currentDetailRead.phase === 'failed' && !matchingFullDetail ? (
          <Text variant="caption" color="tertiary">Latest run could not be checked.</Text>
        ) : currentDetailRead.phase === 'unavailable' && !matchingFullDetail ? (
          <Text variant="caption" color="tertiary">Latest run details are not available from this gateway.</Text>
        ) : isRecord(displayedJob.latestExecution) ? (
          <>
            <Row label="Status" value={executionField(displayedJob.latestExecution, 'status')} />
            <Row label="Started" value={executionField(displayedJob.latestExecution, 'started_at', 'startedAt')} />
            <Row label="Finished" value={executionField(displayedJob.latestExecution, 'finished_at', 'finishedAt')} />
            <Row label="Error" value={executionError(displayedJob.latestExecution)} />
          </>
        ) : (
          <Text variant="caption" color="secondary">No latest run details were returned.</Text>
        )}

        <Divider />

        <Button
          label={showPrompt ? 'Hide prompt' : promptLength === null ? 'Show prompt (not loaded)' : `Show prompt (${promptLength} chars)`}
          variant="ghost"
          size="sm"
          expanded={showPrompt}
          onPress={() => setShowPrompt((open) => !open)}
        />
        {showPrompt ? (
          <Text variant="micro" style={styles.mono} selectable>
            {typeof displayedJob.prompt === 'string' ? displayedJob.prompt || '—' : 'Prompt not loaded.'}
          </Text>
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
                {editRefreshNote
                  ? 'The gateway has not confirmed the updated record yet.'
                  : JSON.stringify(displayedJob.raw ?? displayedJob, null, 2)}
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

        <Text variant="micro" color="tertiary">{`CONVERSATION TRANSCRIPTS (${runs.length})`}</Text>
        <Text variant="micro" color="tertiary">
          Earlier transcripts may be unavailable on this gateway.
        </Text>
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
          <Text variant="caption" color="secondary">No linked transcripts are available.</Text>
        ) : null}
        {runs.map((run) => (
          <ListRow
            key={run.id}
            title={run.at ?? run.id}
            subtitle={cronRunSummary(run)}
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
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  editor: { gap: Spacing.two, paddingVertical: Spacing.two },
  field: { gap: 2 },
  row: { marginBottom: Spacing.one },
  gap: { marginTop: Spacing.two },
  mono: { fontFamily: 'monospace' },
  rawCard: {
    borderWidth: 1,
    borderColor: Palette.border,
    borderRadius: 8,
    padding: Spacing.two,
  },
  rawScroll: {
    maxHeight: 200,
  },
});
