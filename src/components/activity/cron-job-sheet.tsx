import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BaseSheet, Button, Divider, ListRow, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { haptics } from '@/lib/haptics';
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
export function CronJobSheet({ job, onClose, onOpenRun }: CronJobSheetProps) {
  const { cron } = useGateway();
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const jobId = job?.id ?? null;
  const loadRuns = useCallback(async () => {
    if (!jobId) return;
    try {
      setRuns(await cron.runs(jobId));
      setRunsError(null);
    } catch (caught) {
      setRunsError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [cron, jobId]);

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
          onPress={() => setShowPrompt((open) => !open)}
        />
        {showPrompt ? (
          <Text variant="micro" style={styles.mono} selectable>{job.prompt || '—'}</Text>
        ) : null}

        <Button
          label={showRaw ? 'Hide raw record' : 'Show raw record'}
          variant="ghost"
          size="sm"
          onPress={() => setShowRaw((open) => !open)}
        />
        {showRaw ? (
          <Text variant="micro" style={styles.mono} selectable>
            {JSON.stringify(job.raw ?? job, null, 2)}
          </Text>
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
        {!runsError && runs.length === 0 ? (
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
  field: { gap: 2 },
  row: { marginBottom: Spacing.one },
  mono: { fontFamily: 'monospace' },
});
