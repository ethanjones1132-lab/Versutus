import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BaseSheet, Badge, Button, Chip, ListRow, Text, TextField } from '@/components/ui';
import { Palette, Radius, Spacing } from '@/constants/tokens';
import type { createEnvironmentClient } from '@/lib/gateway/environment-client';
import type {
  EnvironmentRunEvent,
  EnvironmentRunSummary,
  EnvironmentSnapshot,
} from '@/lib/gateway/environment-types';
import { environmentRunBadge, environmentRunView } from '@/lib/gateway/environment-run-view';

type Client = ReturnType<typeof createEnvironmentClient>;

const TERMINAL_EVENT = /^run\.(completed|failed|cancelled)$/;

function approvalFrom(event: EnvironmentRunEvent): { id: string; summary: string } | null {
  if (!/approval/i.test(event.type)) return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const id = payload.approvalId ?? payload.id;
  if (typeof id !== 'string') return null;
  const summary =
    typeof payload.summary === 'string'
      ? payload.summary
      : typeof payload.command === 'string'
        ? payload.command
        : 'This run needs your approval to continue.';
  return { id, summary };
}

function summaryBadge(run: EnvironmentRunSummary): { label: string; tone: 'accent' | 'success' | 'danger' | 'neutral' } {
  switch (run.state) {
    case 'completed':
      return { label: run.exitCode !== null ? `Completed · exit ${run.exitCode}` : 'Completed', tone: 'success' };
    case 'failed':
      return { label: 'Failed', tone: 'danger' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral' };
    default:
      return { label: 'Running', tone: 'accent' };
  }
}

function clockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * Start a CLI run and watch it live. Streamed output is folded into one reply
 * bubble with a terminal-state badge, so the buyer sees a reply arrive — not
 * an event log. If the stream drops before the run finishes (phone lock,
 * network blip), the recent-runs list reconnects: the Gate replays a run's
 * events from the beginning to any subscriber. Interactive operations are
 * excluded: the adapter marks them non-machine-readable because they expect a
 * real terminal.
 */
export function EnvironmentRunLauncher({
  environment,
  client,
  visible,
  onClose,
}: {
  environment: EnvironmentSnapshot | null;
  client: Client;
  visible: boolean;
  onClose: () => void;
}) {
  const [operation, setOperation] = useState('prompt');
  const [prompt, setPrompt] = useState('');
  const [events, setEvents] = useState<EnvironmentRunEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<{ id: string; summary: string } | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runs, setRuns] = useState<EnvironmentRunSummary[]>([]);
  // The stream ended while the run was still live — never claim "Running"
  // over a connection that is gone; offer reattachment instead.
  const [detached, setDetached] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastEventTypeRef = useRef<string | null>(null);

  const view = useMemo(() => environmentRunView(events), [events]);

  /**
   * Run history is best-effort: a gateway that cannot list runs must not
   * block starting one. The live path never depends on this succeeding.
   */
  const refreshRuns = useCallback(() => {
    if (!environment) return;
    client
      .listRuns(environment.id)
      .then(setRuns)
      .catch(() => setRuns([]));
  }, [client, environment]);

  useEffect(() => {
    if (visible) refreshRuns();
  }, [visible, refreshRuns]);

  /** Stream a run to its end — or to whatever the connection leaves us with. */
  async function follow(environmentId: string, runId: string) {
    lastEventTypeRef.current = null;
    setDetached(false);
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await client.streamRun(
        environmentId,
        runId,
        (event) => {
          lastEventTypeRef.current = event.type;
          setEvents((current) => [...current, event]);
          const pending = approvalFrom(event);
          if (pending) setApproval(pending);
        },
        controller.signal,
      );
      if (!controller.signal.aborted && !TERMINAL_EVENT.test(lastEventTypeRef.current ?? '')) {
        setDetached(true);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
      abortRef.current = null;
      refreshRuns();
    }
  }

  async function start() {
    if (!environment) return;
    setError(null);
    setEvents([]);
    setApproval(null);
    setRunning(true);
    try {
      const { runId } = await client.startRun(environment.id, {
        operation,
        input: operation === 'prompt' ? { prompt } : {},
      });
      setActiveRunId(runId);
      await follow(environment.id, runId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setRunning(false);
    }
  }

  /** Reattach to a known run: the replay folds into the same reply bubble. */
  async function attach(runId: string) {
    if (!environment || running) return;
    setError(null);
    setEvents([]);
    setApproval(null);
    setActiveRunId(runId);
    await follow(environment.id, runId);
  }

  async function cancel() {
    abortRef.current?.abort();
    if (environment && activeRunId) {
      await client.cancelRun(environment.id, activeRunId).catch(() => undefined);
    }
    setRunning(false);
    refreshRuns();
  }

  async function decide(decision: 'approve' | 'deny') {
    if (!environment || !activeRunId || !approval) return;
    await client
      .approveRun(environment.id, activeRunId, approval.id, decision)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    setApproval(null);
  }

  const operations = ['prompt', 'status'];
  const badge = detached ? { label: 'Detached', tone: 'neutral' as const } : environmentRunBadge(view, { starting: running && events.length === 0 });

  return (
    <BaseSheet visible={visible} onClose={onClose}>
      <Text variant="title">{environment ? `Run · ${environment.label}` : 'Run'}</Text>
      {environment ? (
        <Text variant="caption">
          {environment.workspacePolicy.defaultSandbox} · {environment.workspacePolicy.defaultRoot}
        </Text>
      ) : null}

      <View style={styles.row}>
        {operations.map((item) => (
          <Chip
            key={item}
            label={item}
            selected={item === operation}
            onPress={() => setOperation(item)}
            disabled={running}
          />
        ))}
      </View>

      {operation === 'prompt' ? (
        <TextField
          value={prompt}
          onChangeText={setPrompt}
          placeholder="What should it do?"
          multiline
          style={styles.prompt}
        />
      ) : null}

      {error ? <Text variant="caption">{error}</Text> : null}

      <View style={styles.statusRow}>
        {badge ? <Badge label={badge.label} tone={badge.tone} /> : null}
        {view.failureDetail ? <Text variant="caption">{view.failureDetail}</Text> : null}
      </View>

      {detached ? (
        <Text variant="caption" color="secondary">
          The connection ended before the run finished. Reopen it from Recent runs — the full output replays.
        </Text>
      ) : null}

      {approval ? (
        <View style={styles.approval}>
          <Text variant="caption">{approval.summary}</Text>
          <View style={styles.row}>
            <Button label="Approve" onPress={() => void decide('approve')} />
            <Button label="Deny" variant="secondary" onPress={() => void decide('deny')} />
          </View>
        </View>
      ) : null}

      <ScrollView style={styles.log}>
        <View style={[styles.bubble, view.replyText ? null : styles.bubblePending]}>
          {view.replyText ? (
            <Text variant="mono" selectable>
              {view.replyText}
            </Text>
          ) : (
            <Text variant="caption">{running && events.length === 0 ? 'Starting…' : 'No output yet.'}</Text>
          )}
        </View>
        {view.stderrText ? (
          <View style={styles.diagnostics}>
            <Text variant="micro">stderr</Text>
            <Text variant="mono" color="tertiary" selectable>
              {view.stderrText}
            </Text>
          </View>
        ) : null}
        {view.notes.map((note, index) => (
          <Text key={`${index}-${note}`} variant="caption" color="tertiary">
            {note}
          </Text>
        ))}
      </ScrollView>

      {runs.length > 0 ? (
        <View style={styles.history}>
          <Text variant="micro">Recent runs</Text>
          {runs.slice(0, 5).map((run) => (
            <ListRow
              key={run.runId}
              title={`${run.operation} · ${run.runId}`}
              subtitle={clockTime(run.startedAt)}
              onPress={running ? undefined : () => void attach(run.runId)}
              trailing={<Badge label={summaryBadge(run).label} tone={summaryBadge(run).tone} />}
            />
          ))}
        </View>
      ) : null}

      <View style={styles.row}>
        {running ? (
          <Button label="Cancel run" variant="destructive" onPress={() => void cancel()} />
        ) : (
          <Button
            label="Start run"
            onPress={() => void start()}
            disabled={!environment || (operation === 'prompt' && !prompt.trim())}
          />
        )}
        <Button label="Close" variant="secondary" onPress={onClose} />
      </View>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, marginTop: Spacing.two },
  prompt: { minHeight: 72, marginTop: Spacing.two },
  approval: { gap: Spacing.one, marginTop: Spacing.two },
  statusRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: Spacing.two, marginTop: Spacing.two },
  log: { maxHeight: 240, marginTop: Spacing.two },
  history: { marginTop: Spacing.two, gap: Spacing.one },
  bubble: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    borderRadius: Radius.md,
    padding: Spacing.two,
    minHeight: 44,
  },
  bubblePending: { borderStyle: 'dashed', opacity: 0.7 },
  diagnostics: { gap: Spacing.one, marginTop: Spacing.two },
});
