import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button, Card, Screen, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { looksLikeCredential } from '@/lib/gateway/credential-shape';
import {
  defaultConfigForFields,
  isValidInstanceId,
  parseFieldValue,
  stringifyFieldValue,
} from '@/lib/gateway/capability-form';
import type { GatewayCapabilityField, GatewayCapabilityKind } from '@/lib/portal/manifest';

type RegistryInstance = {
  id: string;
  kind: string;
  label: string;
  config: Record<string, unknown>;
};

type Draft = {
  mode: 'create' | 'edit';
  id: string;
  kind: string;
  label: string;
  values: Record<string, string>;
  secretValue: string;
};

export default function CapabilityEditorScreen() {
  const { status, gatewayRequest, refreshCapabilities } = useGateway();
  const [kinds, setKinds] = useState<GatewayCapabilityKind[]>([]);
  const [instances, setInstances] = useState<RegistryInstance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    if (status !== 'connected') {
      setError('Connect to a Gate to manage capabilities.');
      return;
    }
    try {
      const [nextKinds, nextInstances] = await Promise.all([
        gatewayRequest<GatewayCapabilityKind[]>('registry.kinds.list'),
        gatewayRequest<RegistryInstance[]>('registry.instances.list'),
      ]);
      setKinds(Array.isArray(nextKinds) ? nextKinds : []);
      setInstances(Array.isArray(nextInstances) ? nextInstances : []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [gatewayRequest, status]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const selectedKind = useMemo(
    () => kinds.find((kind) => kind.id === draft?.kind) ?? null,
    [draft?.kind, kinds],
  );

  function startCreate(kind: GatewayCapabilityKind) {
    const config = defaultConfigForFields(kind.configFields);
    const values: Record<string, string> = {};
    for (const field of kind.configFields) {
      values[field.key] = stringifyFieldValue(field, config[field.key]);
    }
    setDraft({ mode: 'create', id: '', kind: kind.id, label: '', values, secretValue: '' });
  }

  function startEdit(instance: RegistryInstance) {
    const kind = kinds.find((entry) => entry.id === instance.kind);
    const fields = kind?.configFields ?? [];
    const values: Record<string, string> = {};
    for (const field of fields) {
      values[field.key] = stringifyFieldValue(field, instance.config[field.key]);
    }
    setDraft({
      mode: 'edit',
      id: instance.id,
      kind: instance.kind,
      label: instance.label,
      values,
      secretValue: '',
    });
  }

  function configFromDraft(fields: GatewayCapabilityField[]): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    for (const field of fields) {
      config[field.key] = parseFieldValue(field, draft?.values[field.key] ?? '');
    }
    return config;
  }

  async function saveDraft() {
    if (!draft || !selectedKind) return;
    if (draft.mode === 'create' && !isValidInstanceId(draft.id)) {
      setError('Instance id must be lowercase alphanumeric with hyphens.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const config = configFromDraft(selectedKind.configFields);
      if (draft.mode === 'create') {
        await gatewayRequest('registry.instances.create', {
          id: draft.id,
          kind: draft.kind,
          label: draft.label || draft.id,
          config,
        });
      } else {
        await gatewayRequest('registry.instances.update', {
          id: draft.id,
          label: draft.label || draft.id,
          config,
        });
      }
      const secretField = selectedKind.configFields.find((field) => field.type === 'secret-ref');
      const refName = secretField ? String(config[secretField.key] ?? '') : '';
      if (refName && draft.secretValue.trim()) {
        // The Gate refuses this too, but catching it here can name the field.
        if (looksLikeCredential(refName)) {
          setError(
            `"${secretField?.label ?? 'Secret ref'}" holds the secret's name, not the secret. Put the key in "Secret value" and give this field a name like "my-api-key".`,
          );
          return;
        }
        await gatewayRequest('registry.secrets.set', { refName, value: draft.secretValue.trim() });
      }
      setDraft(null);
      await refreshCapabilities();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete(instance: RegistryInstance) {
    Alert.alert('Delete capability?', `${instance.label} (${instance.id}) will be removed from the Gate.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              await gatewayRequest('registry.instances.delete', { id: instance.id });
              await refreshCapabilities();
              await load();
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : String(caught));
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Text variant="title">Capabilities</Text>
        <Text variant="caption" color="secondary">
          Create, edit, and delete Gate capability instances. Provider auth and CLI environments have dedicated screens.
        </Text>

        {error ? (
          <Text variant="caption" color="statusDisconnected" selectable>
            {error}
          </Text>
        ) : null}

        {draft && selectedKind ? (
          <Card padding={Spacing.three} style={styles.card}>
            <Text variant="headline">{draft.mode === 'create' ? `Add ${selectedKind.label}` : `Edit ${draft.id}`}</Text>
            {draft.mode === 'create' ? (
              <TextField
                value={draft.id}
                onChangeText={(id) => setDraft({ ...draft, id })}
                placeholder="instance-id"
              />
            ) : null}
            <TextField
              value={draft.label}
              onChangeText={(label) => setDraft({ ...draft, label })}
              placeholder="Label"
            />
            {selectedKind.configFields.map((field) => (
              <View key={field.key} style={styles.field}>
                <Text variant="caption" color="secondary">
                  {field.label}
                  {field.required ? ' *' : ''}
                  {field.type === 'enum' && field.options ? ` (${field.options.join(', ')})` : ''}
                </Text>
                <TextField
                  value={draft.values[field.key] ?? ''}
                  onChangeText={(text) =>
                    setDraft({ ...draft, values: { ...draft.values, [field.key]: text } })
                  }
                  placeholder={field.help ?? field.type}
                  autoCapitalize={field.type === 'secret-ref' ? 'none' : undefined}
                  autoCorrect={field.type === 'secret-ref' ? false : undefined}
                  // Deliberately not secureTextEntry: this holds the secret's
                  // *name*, not the secret. Masking it made it read as a
                  // password field, which is how a real key ended up here — and
                  // the vault then wrote that key into a filename on disk.
                />
              </View>
            ))}
            {selectedKind.configFields.some((field) => field.type === 'secret-ref') ? (
              <View style={styles.field}>
                <Text variant="caption" color="secondary">
                  Secret value — the key itself. The ref field above only names it.
                </Text>
                <TextField
                  value={draft.secretValue}
                  onChangeText={(secretValue) => setDraft({ ...draft, secretValue })}
                  placeholder="paste secret"
                  secureTextEntry
                />
              </View>
            ) : null}
            <View style={styles.row}>
              <Button label="Cancel" variant="ghost" onPress={() => setDraft(null)} disabled={busy} />
              <Button label={busy ? 'Saving…' : 'Save'} onPress={() => void saveDraft()} disabled={busy} />
            </View>
          </Card>
        ) : (
          <>
            <Card padding={Spacing.three} style={styles.card}>
              <Text variant="headline">Configured</Text>
              {instances.length === 0 ? (
                <Text variant="caption" color="secondary">
                  No instances yet.
                </Text>
              ) : (
                instances.map((instance) => (
                  <View key={instance.id} style={styles.instanceRow}>
                    <Pressable onPress={() => startEdit(instance)} style={styles.instanceCopy}>
                      <Text>{instance.label}</Text>
                      <Text variant="caption" color="tertiary">
                        {instance.kind} · {instance.id}
                      </Text>
                    </Pressable>
                    <Button label="Delete" variant="ghost" size="sm" onPress={() => confirmDelete(instance)} />
                  </View>
                ))
              )}
            </Card>

            <Card padding={Spacing.three} style={styles.card}>
              <Text variant="headline">Add</Text>
              {kinds.map((kind) => (
                <Button
                  key={kind.id}
                  label={`Add ${kind.label}`}
                  variant="secondary"
                  onPress={() => startCreate(kind)}
                />
              ))}
            </Card>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.four,
    gap: Spacing.three,
  },
  card: {
    gap: Spacing.two,
  },
  field: {
    gap: Spacing.one,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.two,
  },
  instanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  instanceCopy: {
    flex: 1,
  },
});
