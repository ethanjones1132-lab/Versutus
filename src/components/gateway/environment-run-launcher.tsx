import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BaseSheet, Button, Chip, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import type { createEnvironmentClient } from '@/lib/gateway/environment-client';
import type { EnvironmentRunEvent, EnvironmentSnapshot } from '@/lib/gateway/environment-types';

type Client = ReturnType<typeof createEnvironmentClient>;

/** Human text for a run event, falling back to the raw payload. */
function describe(event: EnvironmentRunEvent): string {
  const payload = event.payload ?? {};
  const text = payload.text ?? payload.message ?? payload.delta ?? payload.output;
  if (typeof text === 'string' && text) return text;
  return `${event.type} ${JSON.stringify(payload)}`.trim();
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

/**
 * Start a CLI run and watch it live. Interactive operations are excluded: the
 * adapter marks them non-machine-readable because they expect a real terminal.
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
        {events.map((event) => (
          <Text key={`${event.runId}-${event.sequence}`} variant="caption">
            {describe(event)}
          </Text>
        ))}
        {events.length === 0 && running ? <Text variant="caption">Starting…</Text> : null}
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
  log: { maxHeight: 240, marginTop: Spacing.two },
});
