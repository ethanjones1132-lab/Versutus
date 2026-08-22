import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Chip, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import type { CreateEnvironmentInput } from '@/lib/gateway/environment-client';
import type { EnvironmentAdapter } from '@/lib/gateway/environment-types';
import type { ProviderSnapshot } from '@/lib/gateway/provider-types';

/**
 * Register a CLI environment from the phone. The adapter supplies its own
 * version policy and protocol preference, so the operator supplies the two
 * things only they know: where the executable lives and which folder it may
 * touch. Sandbox defaults to read_only — widening is a deliberate edit.
 *
 * With `initial` present the same form edits an existing environment: fields
 * prefill from the live snapshot, the id is fixed (an update cannot rename a
 * record), and saving routes through environments.update.
 */
export function EnvironmentRegistrationForm({
  adapters,
  providers,
  onSubmit,
  onCancel,
  busy,
  error,
  initial,
}: {
  adapters: EnvironmentAdapter[];
  providers: ProviderSnapshot[];
  onSubmit: (input: CreateEnvironmentInput) => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
  /** Present → edit mode; prefilled from the environment being edited. */
  initial?: CreateEnvironmentInput;
}) {
  const editing = initial !== undefined;
  const [adapter, setAdapter] = useState<EnvironmentAdapter | null>(initial?.adapter ?? null);
  const [id, setId] = useState(initial?.id ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [executablePath, setExecutablePath] = useState(initial?.executablePath ?? '');
  const [workspaceRoot, setWorkspaceRoot] = useState(initial?.workspaceRoot ?? '');
  const [providerRefs, setProviderRefs] = useState<string[]>(initial?.providerRefs ?? []);

  /** Prefill from the chosen adapter so only the machine-specific fields remain. */
  function chooseAdapter(next: EnvironmentAdapter) {
    setAdapter(next);
    setId((current) => current || `${next.adapterId}-local`);
    setLabel((current) => current || next.adapterId);
  }

  const idIsValid = /^[a-z0-9][a-z0-9-]*$/.test(id);
  const canSubmit = !!adapter && idIsValid && !!executablePath.trim() && !!workspaceRoot.trim() && !busy;

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <Text variant="title">{editing ? 'Edit CLI environment' : 'Add a CLI environment'}</Text>
      {editing ? (
        <Text variant="caption">
          Id “{initial.id}” is fixed — rename by removing and re-adding the environment.
        </Text>
      ) : adapters.length === 0 ? (
        <Text variant="caption">
          This Gate advertises no CLI adapters. Update the Gate to register environments from here.
        </Text>
      ) : (
        <>
          <Text variant="caption">Which CLI?</Text>
          <View style={styles.row}>
            {adapters.map((item) => (
              <Chip
                key={item.adapterId}
                label={item.adapterId}
                selected={item.adapterId === adapter?.adapterId}
                onPress={() => chooseAdapter(item)}
              />
            ))}
          </View>
        </>
      )}

      {adapter ? (
        <>
          {!editing && adapter.supportedCliVersions ? (
            <Text variant="caption">Supported versions {adapter.supportedCliVersions}</Text>
          ) : null}
          {!editing ? (
            <>
              <Text variant="caption">Id — lowercase letters, numbers and hyphens</Text>
              <TextField
                value={id}
                onChangeText={setId}
                placeholder={`${adapter.adapterId}-local`}
                validationState={id.length === 0 ? 'default' : idIsValid ? 'valid' : 'invalid'}
              />
            </>
          ) : null}
          <Text variant="caption">Display name</Text>
          <TextField value={label} onChangeText={setLabel} placeholder={adapter.adapterId} />
          <Text variant="caption">Executable path on the Gate machine</Text>
          <TextField
            value={executablePath}
            onChangeText={setExecutablePath}
            placeholder="C:\\Users\\you\\AppData\\Roaming\\npm\\…\\opencode.exe"
          />
          <Text variant="caption">Workspace root — the only folder this CLI may read</Text>
          <TextField
            value={workspaceRoot}
            onChangeText={setWorkspaceRoot}
            placeholder="C:\\Projects\\Versutus"
          />
          {providers.length > 0 ? (
            <>
              <Text variant="caption">Providers this CLI may route through (optional)</Text>
              <View style={styles.row}>
                {providers.map((item) => (
                  <Chip
                    key={item.id}
                    label={item.label}
                    selected={providerRefs.includes(item.id)}
                    onPress={() =>
                      setProviderRefs((current) =>
                        current.includes(item.id)
                          ? current.filter((ref) => ref !== item.id)
                          : [...current, item.id],
                      )
                    }
                  />
                ))}
              </View>
            </>
          ) : null}
          <Text variant="caption">
            Starts read-only on demand. The CLI never receives your provider keys — it calls back
            into the Gate with a short-lived invocation token. Saving keeps the sandbox and other
            Gate-side settings exactly as they are.
          </Text>
        </>
      ) : null}

      {error ? <Text variant="caption">{error}</Text> : null}

      <View style={styles.actions}>
        <Button
          label={busy ? (editing ? 'Saving…' : 'Registering…') : editing ? 'Save changes' : 'Register'}
          onPress={() => {
            if (!adapter) return;
            onSubmit({ id, label, adapter, executablePath, workspaceRoot, providerRefs });
          }}
          disabled={!canSubmit}
        />
        <Button label="Cancel" variant="secondary" onPress={onCancel} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two, marginBottom: Spacing.three },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, marginTop: Spacing.two },
});
