import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, ListRow, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { parseRoutineName } from '@/lib/gateway/routines';

export type RoutineJob = { id: string; name?: string; paused?: boolean };

export function RoutinesPane({
  jobs,
  onCreate,
  onRun,
  onTogglePause,
}: {
  jobs: RoutineJob[];
  onCreate: (input: { title: string; prompt: string; schedule: string }) => void;
  onRun: (jobId: string) => void;
  onTogglePause: (jobId: string, paused: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [schedule, setSchedule] = useState('0 9 * * *');

  return (
    <View style={styles.wrap}>
      <Button label={open ? 'Hide routines' : `Routines (${jobs.length})`} variant="ghost" size="sm" onPress={() => setOpen((value) => !value)} />
      {open ? (
        <View style={styles.body}>
          {jobs.map((job) => {
            const parsed = parseRoutineName(job.name ?? job.id);
            return (
              <ListRow
                key={job.id}
                title={parsed.title || job.id}
                subtitle={job.paused ? 'paused' : 'active'}
                onPress={() => onRun(job.id)}
                trailing={
                  <Button
                    label={job.paused ? 'Resume' : 'Pause'}
                    variant="ghost"
                    size="sm"
                    onPress={() => onTogglePause(job.id, !job.paused)}
                  />
                }
              />
            );
          })}
          <Text variant="micro" color="secondary">
            New routine
          </Text>
          <TextField value={title} onChangeText={setTitle} placeholder="inbox" />
          <TextField value={schedule} onChangeText={setSchedule} placeholder="0 9 * * *" />
          <TextField value={prompt} onChangeText={setPrompt} placeholder="Summarize overnight mail" multiline />
          <Button
            label="Add"
            disabled={!title.trim() || !prompt.trim()}
            onPress={() => {
              onCreate({ title: title.trim(), prompt: prompt.trim(), schedule: schedule.trim() || '0 9 * * *' });
              setTitle('');
              setPrompt('');
            }}
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
