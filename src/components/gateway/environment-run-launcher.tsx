import { useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BaseSheet, Badge, Button, Chip, Text, TextField } from '@/components/ui';
import { Palette, Radius, Spacing } from '@/constants/tokens';
import type { createEnvironmentClient } from '@/lib/gateway/environment-client';
import type { EnvironmentRunEvent, EnvironmentSnapshot } from '@/lib/gateway/environment-types';
import { environmentRunBadge, environmentRunView } from '@/lib/gateway/environment-run-view';

type Client = ReturnType<typeof createEnvironmentClient>;

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

/**
 * Start a CLI run and watch it live. Streamed output is folded into one reply
 * bubble with a terminal-state badge, so the buyer sees a reply arrive — not
 * an event log. Interactive operations are excluded: the adapter marks them
 * non-machine-readable because they expect a real terminal.
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
  const runIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const view = useMemo(() => environmentRunView(events), [events]);
  const badge = environmentRunBadge(view, { starting: running && events.length === 0 });

  async function start() {
    if (!environment) return;
    setRunning(true);
    setError(null);
    setEvents([]);
    setApproval(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { runId } = await client.startRun(environment.id, {
        operation,
        input: operation === 'prompt' ? { prompt } : {},
      });
      runIdRef.current = runId;
      await client.streamRun(
        environment.id,
        runId,
        (event) => {
          setEvents((current) => [...current, event]);
          const pending = approvalFrom(event);
          if (pending) setApproval(pending);
        },
        controller.signal,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  async function cancel() {
    abortRef.current?.abort();
    if (environment && runIdRef.current) {
      await client.cancelRun(environment.id, runIdRef.current).catch(() => undefined);
    }
    setRunning(false);
  }

  async function decide(decision: 'approve' | 'deny') {
    if (!environment || !runIdRef.current || !approval) return;
    await client
      .approveRun(environment.id, runIdRef.current, approval.id, decision)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    setApproval(null);
  }

  const operations = ['prompt', 'status'];

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
