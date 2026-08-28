import { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { BaseSheet, Button, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

export type NewAgentDraft = {
  name: string;
  soul?: string;
  inheritKeys: boolean;
  description?: string;
  modelId?: string;
  providerId?: string;
};

/** Prefill for an existing Bot — the same sheet doubles as the edit form. */
export type EditAgentInitial = {
  name: string;
  description: string;
  modelId: string;
  providerId: string;
};

export function NewAgentSheet({
  visible,
  busy,
  error,
  initial,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  busy?: boolean;
  error?: string;
  /** Present when editing an existing Bot; the parent keys this sheet by target so state resets. */
  initial?: EditAgentInitial;
  onClose: () => void;
  onSubmit: (draft: NewAgentDraft) => void;
}) {
  const editing = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? '');
  const [soul, setSoul] = useState('');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [modelId, setModelId] = useState(initial?.modelId ?? '');
  const [providerId, setProviderId] = useState(initial?.providerId ?? '');
  const [inheritKeys, setInheritKeys] = useState(true);

  const reset = () => {
    setName('');
    setSoul('');
    setDescription('');
    setModelId('');
    setProviderId('');
    setInheritKeys(true);
  };

  return (
    <BaseSheet
      visible={visible}
      eyebrow="BOTS"
      title={editing ? 'Edit Agent' : 'New Agent'}
      onClose={() => {
        reset();
        onClose();
      }}
      closeLabel="Dismiss">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.pad}>
        <Text variant="caption" color="tertiary" style={styles.blurb}>
          {editing
            ? 'Applies only the fields you fill in — a blank field leaves what the Gate holds untouched.'
            : 'Creates a Hermes profile on the host. Inherit copies default provider keys; empty starts with none.'}
        </Text>
        <Text variant="micro" color="secondary">
          Name
        </Text>
        {/* The name is the profile's identity — editing renames nothing, so it stays read-only here. */}
        <TextField value={name} onChangeText={setName} placeholder="researcher" autoCapitalize="none" editable={!editing} />
        <Text variant="micro" color="secondary" style={styles.gap}>
          Description
        </Text>
        <TextField value={description} onChangeText={setDescription} placeholder="Reads code and writes findings" />
        <Text variant="micro" color="secondary" style={styles.gap}>
          Soul
        </Text>
        <TextField
          value={soul}
          onChangeText={setSoul}
          placeholder={editing ? 'Leave unchanged' : 'Standing personality and instructions'}
          multiline
        />
        <Text variant="micro" color="secondary" style={styles.gap}>
          Model pin
        </Text>
        <TextField value={modelId} onChangeText={setModelId} placeholder="provider/model-id" autoCapitalize="none" />
        <Text variant="micro" color="secondary" style={styles.gap}>
          Provider pin
        </Text>
        <TextField value={providerId} onChangeText={setProviderId} placeholder="provider-id" autoCapitalize="none" />
        {!editing ? (
          <Button
            label={inheritKeys ? 'Inherit keys from default' : 'Empty key set'}
            variant="ghost"
            onPress={() => setInheritKeys((value) => !value)}
          />
        ) : null}
        {error ? (
          <Text variant="caption" color="statusDisconnected">
            {error}
          </Text>
        ) : null}
        <Button
          label={busy ? (editing ? 'Saving…' : 'Creating…') : editing ? 'Save' : 'Create'}
          disabled={busy || !name.trim()}
          onPress={() =>
            onSubmit({
              name: name.trim(),
              soul: soul.trim() || undefined,
              inheritKeys,
              description: description.trim() || undefined,
              modelId: modelId.trim() || undefined,
              providerId: providerId.trim() || undefined,
            })
          }
        />
      </ScrollView>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: Spacing.two, paddingBottom: Spacing.four, gap: Spacing.one },
  blurb: { marginBottom: Spacing.two },
  gap: { marginTop: Spacing.two },
});
