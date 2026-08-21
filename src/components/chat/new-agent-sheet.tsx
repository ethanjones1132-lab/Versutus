import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BaseSheet, Button, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

export type NewAgentDraft = {
  name: string;
  soul?: string;
  inheritKeys: boolean;
  description?: string;
};

export function NewAgentSheet({
  visible,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  busy?: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (draft: NewAgentDraft) => void;
}) {
  const [name, setName] = useState('');
  const [soul, setSoul] = useState('');
  const [description, setDescription] = useState('');
  const [inheritKeys, setInheritKeys] = useState(true);

  const reset = () => {
    setName('');
    setSoul('');
    setDescription('');
    setInheritKeys(true);
  };

  return (
    <BaseSheet
      visible={visible}
      eyebrow="BOTS"
      title="New Agent"
      onClose={() => {
        reset();
        onClose();
      }}
      closeLabel="Dismiss">
      <View style={styles.pad}>
        <Text variant="caption" color="tertiary" style={styles.blurb}>
          Creates a Hermes profile on the host. Inherit copies default provider keys; empty starts with none.
        </Text>
        <Text variant="micro" color="secondary">
          Name
        </Text>
        <TextField value={name} onChangeText={setName} placeholder="researcher" autoCapitalize="none" />
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
          placeholder="Standing personality and instructions"
          multiline
        />
        <Button
          label={inheritKeys ? 'Inherit keys from default' : 'Empty key set'}
          variant="ghost"
          onPress={() => setInheritKeys((value) => !value)}
        />
        {error ? (
          <Text variant="caption" color="statusDisconnected">
            {error}
          </Text>
        ) : null}
        <Button
          label={busy ? 'Creating…' : 'Create'}
          disabled={busy || !name.trim()}
          onPress={() =>
            onSubmit({
              name: name.trim(),
              soul: soul.trim() || undefined,
              inheritKeys,
              description: description.trim() || undefined,
            })
          }
        />
      </View>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: Spacing.two, paddingBottom: Spacing.four, gap: Spacing.one },
  blurb: { marginBottom: Spacing.two },
  gap: { marginTop: Spacing.two },
});
