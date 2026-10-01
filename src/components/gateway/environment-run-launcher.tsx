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
import { operationNeedsPromptInput, resolveLauncherOperations } from '@/lib/gateway/environment-operations';
import { formatRunFailure } from '@/lib/gateway/run-failures';

type Client = ReturnType<typeof createEnvironmentClient>;

const TERMINAL_EVENT = /^run\.(completed|failed|cancelled)$/;

/**
 * How many streamed events one run may keep in memory. A chatty CLI can emit
 * thousands of frames in a single run; the sheet folds them into one reply, so
 * the tail is what matters and the head can go.
 */
export const MAX_RUN_EVENTS = 2000;

/** Keep the newest MAX_RUN_EVENTS, plus the `run.started` marker if the tail
 *  has already dropped it, so the bubble still says the run opened. */
export function capRunEvents(events: EnvironmentRunEvent[]): EnvironmentRunEvent[] {
  if (events.length <= MAX_RUN_EVENTS) return events;
  const kept = events.slice(-MAX_RUN_EVENTS);
  const opened = events.find((event) => event.type === 'run.started');
  if (!opened || kept.includes(opened)) return kept;
  return [opened, ...kept.slice(-(MAX_RUN_EVENTS - 1))];
}

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
  // Which follow owns the sheet right now. A run's callbacks and its `finally`
  // compare against it and do nothing once it has moved on, so a stream that
  // outlives its sheet can never write into the next run's bubble.
  const runTokenRef = useRef(0);
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

  /**
   * The catalog read is best-effort: a gateway that cannot list commands
   * must not block starting a prompt/status run. A failed read leaves the
   * default pair in place. The catalog is tagged with the environment it
   * was read for, so a stale answer never leaks across environments.
   */
  const [catalog, setCatalog] = useState<{ envId: string; operations: string[] } | null>(null);
  useEffect(() => {
    if (!visible || !environment) return;
    const envId = environment.id;
    let cancelled = false;
    client
      .listCommands(envId)
      .then((entries) => {
        if (!cancelled) setCatalog({ envId, operations: resolveLauncherOperations(entries) });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, environment, visible]);

  const operations = useMemo(
    () => (visible && environment && catalog?.envId === environment.id ? catalog.operations : ['prompt', 'status']),
    [catalog, environment, visible],
  );
  // The catalog may not name the selected verb (e.g. switching from a
  // prompt environment to a Codex one that serves exec): derive the first
  // offered verb rather than running one the Gate will reject.
  const effectiveOperation = operations.includes(operation) ? operation : operations[0];
  const needsPromptInput = operationNeedsPromptInput(effectiveOperation);

  /**
   * Retire the run the phone was following: abort its stream and move the run
   * token on, so its callbacks and `finally` are inert even if the abort lands
   * late. Returns the token the next follow may claim.
   */
  const retire = useCallback((): number => {
    abortRef.current?.abort();
    abortRef.current = null;
    runTokenRef.current += 1;
    return runTokenRef.current;
  }, []);

  /**
   * Leaving the sheet — Close, a hardware back, or the section pointing it at
   * another environment — ends the phone's side of the run. The Gate-side run
   * keeps going: that is what Cancel run is for, and the run stays in Recent
   * runs so Reopen replays it.
   */
  const dismiss = useCallback((): void => {
    retire();
    lastEventTypeRef.current = null;
    setEvents([]);
    setApproval(null);
    setActiveRunId(null);
    setDetached(false);
    setRunning(false);
    onClose();
  }, [onClose, retire]);

  /**
   * The transcript belongs to the sheet it was streamed into. Closing the sheet
   * — or aiming it at another environment — starts a blank one, derived during
   * render rather than from an effect: React re-renders before committing, so
   * the old run's output can never appear under a new target and no effect has
   * to set state to get there.
   */
  const sheetKey = `${environment?.id ?? ''}|${visible}`;
  const [streamedFor, setStreamedFor] = useState(sheetKey);
  if (streamedFor !== sheetKey) {
    setStreamedFor(sheetKey);
    setEvents([]);
    setApproval(null);
    setActiveRunId(null);
    setDetached(false);
    setRunning(false);
  }

  useEffect(() => {
    // The external half of the same change: abort the stream the phone was
    // following and move the run token on, so its callbacks and `finally` stay
    // inert even if the abort lands late. No state is written here — the reset
    // above is derived during render.
    retire();
  }, [environment?.id, retire, visible]);

  /** Stream a run to its end — or to whatever the connection leaves us with. */
  async function follow(environmentId: string, runId: string, token: number) {
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
          if (runTokenRef.current !== token) return;
          lastEventTypeRef.current = event.type;
          setEvents((current) => capRunEvents([...current, event]));
          const pending = approvalFrom(event);
          if (pending) setApproval(pending);
        },
        controller.signal,
      );
      if (runTokenRef.current !== token) return;
      if (!controller.signal.aborted && !TERMINAL_EVENT.test(lastEventTypeRef.current ?? '')) {
        setDetached(true);
      }
    } catch (caught) {
      if (runTokenRef.current !== token) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (runTokenRef.current === token) {
        setRunning(false);
        abortRef.current = null;
        refreshRuns();
      }
    }
  }

  async function start() {
    if (!environment) return;
    // Retire any earlier run before claiming the sheet: the second start used
    // to overwrite abortRef and leave the first stream unreachable.
    const token = retire();
    setError(null);
    setEvents([]);
    setApproval(null);
    setRunning(true);
    try {
      const { runId } = await client.startRun(environment.id, {
        operation: effectiveOperation,
        input: operationNeedsPromptInput(effectiveOperation) ? { prompt } : {},
      });
      if (runTokenRef.current !== token) return;
      setActiveRunId(runId);
      await follow(environment.id, runId, token);
    } catch (caught) {
      if (runTokenRef.current !== token) return;
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
    await follow(environment.id, runId, retire());
  }

  async function cancel() {
    // Retire first so the dying stream cannot keep appending, then ask the Gate
    // to stop the run itself — the only place a Gate-side cancel belongs.
    retire();
    if (environment && activeRunId) {
      await client.cancelRun(environment.id, activeRunId).catch(() => undefined);
    }
    setRunning(false);
    refreshRuns();
  }

  async function decide(decision: 'approve' | 'deny') {
    if (!environment || !activeRunId || !approval) return;
    try {
      await client.approveRun(environment.id, activeRunId, approval.id, decision);
      setApproval(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const badge = detached ? { label: 'Detached', tone: 'neutral' as const } : environmentRunBadge(view, { starting: running && events.length === 0 });

  return (
    <BaseSheet visible={visible} onClose={dismiss}>
      <Text variant="title">{environment ? `Run · ${environment.label}` : 'Run'}</Text>
      {environment ? (
        <Text variant="caption">
          {environment.workspacePolicy.defaultSandbox} · {environment.workspacePolicy.defaultRoot}
        </Text>
      ) : null}

      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}>
        <View style={styles.row}>
          {operations.map((item) => (
            <Chip
              key={item}
              label={item}
              selected={item === effectiveOperation}
              onPress={() => setOperation(item)}
              disabled={running}
            />
          ))}
        </View>

        {needsPromptInput ? (
          <TextField
            value={prompt}
            onChangeText={setPrompt}
            placeholder="What should it do?"
            multiline
            style={styles.prompt}
          />
        ) : null}

        {/* Desktop-parity failure state: when the Gate names the host state,
            show verdict + fix and keep the raw text as the cause. */}
        {error ? (
          <Text variant="caption">{formatRunFailure(error) ?? error}</Text>
        ) : null}

        <View style={styles.statusRow}>
          {badge ? <Badge label={badge.label} tone={badge.tone} /> : null}
          {view.failureDetail ? (
            <Text variant="caption">{formatRunFailure(view.failureDetail) ?? view.failureDetail}</Text>
          ) : null}
        </View>

        {detached ? (
          <View style={styles.detached}>
            <Text variant="caption" color="secondary">
              The connection ended before the run finished. Reopen it from Recent runs — the full output replays.
            </Text>
            {activeRunId ? (
              <Button
                label="Reopen"
                onPress={() => void attach(activeRunId)}
                disabled={!environment || running}
              />
            ) : null}
          </View>
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

        <ScrollView style={styles.log} nestedScrollEnabled>
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
              disabled={!environment || (needsPromptInput && !prompt.trim())}
            />
          )}
          <Button label="Close" variant="secondary" onPress={dismiss} />
        </View>
      </ScrollView>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, marginTop: Spacing.two },
  scroll: { paddingBottom: Spacing.two },
  prompt: { minHeight: 72, marginTop: Spacing.two },
  approval: { gap: Spacing.one, marginTop: Spacing.two },
  statusRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: Spacing.two, marginTop: Spacing.two },
  log: { maxHeight: 240, marginTop: Spacing.two },
  history: { marginTop: Spacing.two, gap: Spacing.one },
  detached: { gap: Spacing.one, marginTop: Spacing.two },
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
