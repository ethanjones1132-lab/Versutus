import { memo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { CronJobSheet } from '@/components/activity/cron-job-sheet';
import { CronRunSheet } from '@/components/activity/cron-run-sheet';
import { Button, ListRow, Skeleton, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { ROUTINE_TEMPLATES, applyRoutineTemplate } from '@/lib/gateway/routine-templates';
import {
  ROUTINES_PANE_MAX_HEIGHT,
  applyRoutineCreate,
  cronJobViewFromRoutine,
  DEFAULT_ROUTINE_SCHEDULE,
  describeRoutineError,
  parseRoutineName,
  routineJobSummary,
  routinesListCopy,
  routinesToggleLabel,
  type RoutineJob,
  type RoutinesState,
} from '@/lib/gateway/routines';

export type { RoutineJob };

/** Bot Chat routines pane — wrapped in `memo` so a chat-screen tick that does
 *  not change `jobs`, `loaded`, `failed`, `onCreate`, `onTogglePause`,
 *  `onRetry`, or `onChanged` stops re-rendering this subtree (its
 *  `useState` hooks and the `<ListRow>` rows it maps from `jobs`). Matches
 *  the pattern already shipped on `ChatHeader` (chat-header.tsx:35,176),
 *  `ChatRoster` (chat-roster.tsx:320), `SkillsPane` (skills-pane.tsx:14,81)
 *  and `ToolsPane` (tools-pane.tsx:14,81). Holding this requires the parent
 *  to pass referentially-stable callbacks — see the `handleRoutine*`
 *  `useCallback`s in chat-screen.tsx.
 */
function RoutinesPaneImpl({
  jobs,
  loaded,
  failed,
  onCreate,
  onTogglePause,
  onRetry,
  onChanged,
}: {
  jobs: RoutineJob[];
  loaded: boolean;
  failed: boolean;
  onCreate: (input: { title: string; prompt: string; schedule: string }) => Promise<unknown>;
  onTogglePause: (jobId: string, paused: boolean) => Promise<unknown>;
  /** Re-run the same `botJobs.list` read the surface effect runs. */
  onRetry?: () => void;
  /** Re-read the routine list after the job sheet's Run now / Pause / Remove landed. */
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [schedule, setSchedule] = useState(DEFAULT_ROUTINE_SCHEDULE);
  const [error, setError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [acting, setActing] = useState(false);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const busy = creating || acting;
  const state: RoutinesState = { jobs, loaded, failed };
  const listCopy = routinesListCopy(state);
  const openJob = openJobId ? jobs.find((job) => job.id === openJobId) ?? null : null;

  /**
   * A tapped pack prefills the form and does nothing else: it writes all
   * three draft fields through the pack's own fold, so Add stays the one
   * thing that creates. A key that resolves to no pack leaves the draft
   * alone, and a tap during an in-flight add is dropped rather than letting
   * that add's own result land over the pack the operator just picked.
   */
  const applyTemplate = (key: string) => {
    if (busy) return;
    const next = applyRoutineTemplate({ title, prompt, schedule }, key);
    setTitle(next.title);
    setPrompt(next.prompt);
    setSchedule(next.schedule);
  };

  const submitCreate = () => {
    const submitted = {
      title: title.trim(),
      prompt: prompt.trim(),
      schedule: schedule.trim() || DEFAULT_ROUTINE_SCHEDULE,
    };
    if (!submitted.title || !submitted.prompt || busy) return;
    setCreating(true);
    setError(undefined);
    void Promise.resolve(onCreate(submitted))
      .then(() => {
        const next = applyRoutineCreate(submitted, { ok: true });
        setTitle(next.draft.title);
        setPrompt(next.draft.prompt);
        setSchedule(next.draft.schedule);
      })
      .catch((cause: unknown) => {
        // Fail honest: keep the draft; say why instead of pretending Add landed.
        const next = applyRoutineCreate(submitted, { ok: false, cause });
        setTitle(next.draft.title);
        setPrompt(next.draft.prompt);
        setSchedule(next.draft.schedule);
        setError(next.error);
      })
      .finally(() => setCreating(false));
  };

  const submitPause = (jobId: string, paused: boolean) => {
    if (busy) return;
    setActing(true);
    setError(undefined);
    void Promise.resolve(onTogglePause(jobId, paused))
      .catch((cause: unknown) => {
        setError(describeRoutineError(cause));
      })
      .finally(() => setActing(false));
  };

  return (
    <View style={styles.wrap}>
      <Button
        label={routinesToggleLabel(state, open)}
        variant="ghost"
        size="md"
        expanded={open}
        onPress={() => setOpen((value) => !value)}
      />
      {open ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.body}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {error ? (
            <Text variant="caption" color="accentWarm">
              {error}
            </Text>
          ) : null}
          {!loaded && !failed ? (
            <>
              <Skeleton width="90%" height={44} />
              <Skeleton width="76%" height={44} style={styles.gap} />
            </>
          ) : null}
          {!loaded && failed && onRetry ? (
            <Button label="Retry" variant="ghost" size="sm" onPress={onRetry} />
          ) : null}
          {listCopy ? (
            <Text variant="micro" color="secondary">
              {listCopy}
            </Text>
          ) : null}
          {jobs.map((job) => {
            const parsed = parseRoutineName(job.name ?? job.id);
            return (
              <ListRow
                key={job.id}
                title={parsed.title || job.id}
                subtitle={routineJobSummary(job)}
                onPress={() => setOpenJobId(job.id)}
                trailing={
                  <Button
                    label={job.paused ? 'Resume' : 'Pause'}
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onPress={() => submitPause(job.id, !job.paused)}
                  />
                }
              />
            );
          })}
          <Text variant="micro" color="secondary">
            Templates
          </Text>
          {ROUTINE_TEMPLATES.map((template) => (
            <ListRow
              key={template.key}
              title={template.label}
              subtitle={template.description}
              onPress={() => applyTemplate(template.key)}
            />
          ))}
          <Text variant="micro" color="secondary">
            New routine
          </Text>
          <TextField value={title} onChangeText={setTitle} placeholder="inbox" />
          <TextField value={schedule} onChangeText={setSchedule} placeholder={DEFAULT_ROUTINE_SCHEDULE} />
          <TextField value={prompt} onChangeText={setPrompt} placeholder="Summarize overnight mail" multiline />
          <Button
            label={creating ? 'Adding…' : 'Add'}
            disabled={busy || !title.trim() || !prompt.trim()}
            onPress={submitCreate}
          />
        </ScrollView>
      ) : null}

      {/*
       * The same scheduled-job sheet Activity renders, fed by the slim
       * routine view: run history, Run now, Pause/Resume, and Remove live on
       * the row's tap instead of burying them on the Activity tab. Keyed by
       * job id so each job opens fresh; the run transcript hides the job
       * sheet (two BaseSheets must not stack) and closing it restores this
       * one with the job still in state.
       */}
      <CronJobSheet
        key={openJob?.id ?? 'no-job'}
        job={openJob ? cronJobViewFromRoutine(openJob) : null}
        onClose={() => setOpenJobId(null)}
        onOpenRun={(runId) => setOpenRunId(runId)}
        onRemoved={() => {
          // The row's job no longer exists: close the sheet and let the
          // parent re-read so the row drops without a remount.
          setOpenJobId(null);
          onChanged?.();
        }}
        onChanged={() => {
          // Run now / Pause landed: the parent's row state (paused, next
          // run) is stale until it re-reads.
          onChanged?.();
        }}
      />
      <CronRunSheet key={openRunId ?? 'no-run'} runId={openRunId} onClose={() => setOpenRunId(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.one },
  scroll: { maxHeight: ROUTINES_PANE_MAX_HEIGHT },
  body: { gap: Spacing.one, paddingTop: Spacing.one },
  gap: { marginTop: Spacing.two },
});

export const RoutinesPane = memo(RoutinesPaneImpl);
RoutinesPane.displayName = 'RoutinesPane';
