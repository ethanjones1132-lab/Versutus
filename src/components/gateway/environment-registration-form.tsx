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
 * touch. Sandbox defaults to read_only — widening is a deliberate edit. An
 * optional per-run time budget (lifecycle.maxRunSeconds) lets the Gate stop
 * a hung task on its own.
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
  // Kept as text so an in-progress edit is never a hidden invalid number; the
  // parsed value rides to onSubmit only when it passes validation below.
  const [maxRunSecondsText, setMaxRunSecondsText] = useState(
    initial?.maxRunSeconds !== undefined ? String(initial.maxRunSeconds) : '',
  );
  const [bindingRows, setBindingRows] = useState<{ key: number; envName: string; ref: string }[]>(() =>
    Object.entries(initial?.credentialBindings ?? {}).map(([envName, ref], index) => ({
      key: index,
      envName,
      ref,
    })),
  );
  /**
   * Whether this form may speak about bindings at all. Fresh registrations
   * always can; edits only when the snapshot reported them — an older Gate
   * omits the field, and saving "none" there would wipe mappings the form
   * never saw.
   */
  const bindingsKnown = !editing || initial.credentialBindings !== undefined;

  /** Prefill from the chosen adapter so only the machine-specific fields remain. */
  function chooseAdapter(next: EnvironmentAdapter) {
    setAdapter(next);
    setId((current) => current || `${next.adapterId}-local`);
    setLabel((current) => current || next.adapterId);
  }

  function updateBindingRow(key: number, patch: Partial<{ envName: string; ref: string }>) {
    setBindingRows((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function addBindingRow() {
    setBindingRows((rows) => [
      ...rows,
      { key: rows.reduce((max, row) => Math.max(max, row.key), -1) + 1, envName: '', ref: '' },
    ]);
  }

  function removeBindingRow(key: number) {
    setBindingRows((rows) => rows.filter((row) => row.key !== key));
  }

  const idIsValid = /^[a-z0-9][a-z0-9-]*$/.test(id);
  // Empty = no limit (the Gate's default). Anything else must be a positive
  // whole number of seconds — the same rule the Gate's schema enforces.
  const trimmedLimit = maxRunSecondsText.trim();
  const maxRunSeconds = trimmedLimit.length === 0 ? undefined : Number(trimmedLimit);
  const limitIsValid =
    maxRunSeconds === undefined || (Number.isInteger(maxRunSeconds) && maxRunSeconds > 0);
  // Fully empty rows are ignored; half-filled or duplicate names are a mistake
  // that would silently resolve to nothing (or clobber) at run start.
  const bindingsProblem = (() => {
    const seen = new Set<string>();
    for (const row of bindingRows) {
      const name = row.envName.trim();
      const ref = row.ref.trim();
      if (!name && !ref) continue;
      if (!name || !ref) return 'Each binding needs both a variable name and a vault reference.';
      if (seen.has(name)) return `Duplicate binding for ${name} — merge or rename them.`;
      seen.add(name);
    }
    return null;
  })();
  const canSubmit =
    !!adapter &&
    idIsValid &&
    !!executablePath.trim() &&
    !!workspaceRoot.trim() &&
    limitIsValid &&
    !bindingsProblem &&
    !busy;

  function buildBindings(): Record<string, string> | undefined {
    if (!bindingsKnown) return undefined;
    const bindings: Record<string, string> = {};
    for (const row of bindingRows) {
      const name = row.envName.trim();
      const ref = row.ref.trim();
      if (name && ref) bindings[name] = ref;
    }
    return bindings;
  }

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
          <Text variant="caption">Time limit per run in seconds (optional)</Text>
          <TextField
            value={maxRunSecondsText}
            onChangeText={setMaxRunSecondsText}
            placeholder="No limit"
            validationState={
              maxRunSecondsText.trim().length === 0 || limitIsValid ? 'default' : 'invalid'
            }
          />
          <Text variant="caption">
            When set, the Gate itself stops a task that runs past this budget and the run ends
            Failed naming the limit — a hung task cannot hold the environment forever. Leave empty
            for no limit.
          </Text>
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

          <View style={styles.bindingsHeader}>
            <Text variant="caption">Credential bindings (optional)</Text>
            {bindingsKnown ? (
              <Button label="Add binding" variant="secondary" onPress={addBindingRow} />
            ) : null}
          </View>
          {bindingsKnown ? (
            <>
              <Text variant="caption">
                Pass a secret from the Gate’s vault into this CLI’s environment — e.g.
                ANTHROPIC_API_KEY → provider/anthropic-main/api-key. Set the value once on the
                Providers screen; only variables you bind here reach the CLI.
              </Text>
              {bindingRows.map((row) => (
                <View key={row.key} style={styles.bindingRow}>
                  <TextField
                    value={row.envName}
                    onChangeText={(text) => updateBindingRow(row.key, { envName: text })}
                    placeholder="ENV_VAR_NAME"
                  />
                  <TextField
                    value={row.ref}
                    onChangeText={(text) => updateBindingRow(row.key, { ref: text })}
                    placeholder="provider/my-provider/api-key"
                  />
                  {providers.length > 0 ? (
                    <View style={styles.row}>
                      {providers.map((item) => (
                        <Chip
                          key={item.id}
                          label={`${item.label}${item.auth.state === 'ready' ? ' ✓' : ''}`}
                          selected={row.ref === `provider/${item.id}/api-key`}
                          onPress={() =>
                            updateBindingRow(row.key, { ref: `provider/${item.id}/api-key` })
                          }
                        />
                      ))}
                    </View>
                  ) : null}
                  <Button label="Remove binding" variant="secondary" onPress={() => removeBindingRow(row.key)} />
                </View>
              ))}
              {bindingsProblem ? <Text variant="caption">{bindingsProblem}</Text> : null}
            </>
          ) : (
            <Text variant="caption">
              This Gate does not report existing credential bindings — any stored bindings are kept
              exactly as they are.
            </Text>
          )}
          <Text variant="caption">
            Starts read-only on demand. The CLI calls back into the Gate with a short-lived
            invocation token for model routing — provider keys flow only through bindings above.
            Saving keeps the sandbox, startup mode and concurrency exactly as they are.
          </Text>
        </>
      ) : null}

      {error ? <Text variant="caption">{error}</Text> : null}

      <View style={styles.actions}>
        <Button
          label={busy ? (editing ? 'Saving…' : 'Registering…') : editing ? 'Save changes' : 'Register'}
          onPress={() => {
            if (!adapter) return;
            const credentialBindings = buildBindings();
            onSubmit({
              id,
              label,
              adapter,
              executablePath,
              workspaceRoot,
              providerRefs,
              ...(credentialBindings !== undefined ? { credentialBindings } : {}),
              // Undefined when the field is empty: the record then carries no
              // budget at all ("no limit"), and an edit's patch removes one.
              ...(maxRunSeconds !== undefined ? { maxRunSeconds } : {}),
            });
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
  bindingsHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  bindingRow: { gap: Spacing.two },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, marginTop: Spacing.two },
});
