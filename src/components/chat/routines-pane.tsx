import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, ListRow, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import {
  applyRoutineCreate,
  DEFAULT_ROUTINE_SCHEDULE,
  describeRoutineError,
  parseRoutineName,
  routinesListCopy,
  routinesToggleLabel,
  type RoutineJob,
  type RoutinesState,
} from '@/lib/gateway/routines';

export type { RoutineJob };

export function RoutinesPane({
  jobs,
  loaded,
  failed,
  onCreate,
  onRun,
  onTogglePause,
}: {
  jobs: RoutineJob[];
  loaded: boolean;
  failed: boolean;
  onCreate: (input: { title: string; prompt: string; schedule: string }) => Promise<unknown>;
  onRun: (jobId: string) => Promise<unknown>;
  onTogglePause: (jobId: string, paused: boolean) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [schedule, setSchedule] = useState(DEFAULT_ROUTINE_SCHEDULE);
  const [error, setError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [acting, setActing] = useState(false);
  const busy = creating || acting;
  const state: RoutinesState = { jobs, loaded, failed };
  const listCopy = routinesListCopy(state);

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

  const submitRun = (jobId: string) => {
    if (busy) return;
    setActing(true);
    setError(undefined);
    void Promise.resolve(onRun(jobId))
      .catch((cause: unknown) => {
        setError(describeRoutineError(cause));
      })
      .finally(() => setActing(false));
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
        size="sm"
        onPress={() => setOpen((value) => !value)}
      />
      {open ? (
        <View style={styles.body}>
          {error ? (
            <Text variant="caption" color="accentWarm">
              {error}
            </Text>
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
                subtitle={job.paused ? 'paused' : 'active'}
                onPress={() => submitRun(job.id)}
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
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.one },
  body: { gap: Spacing.one, paddingTop: Spacing.one },
});
