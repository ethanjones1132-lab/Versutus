import { useState } from 'react';

import { BaseSheet, Button, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

export type ProviderKeySheetProps = {
  visible: boolean;
  label: string;
  busy?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
};

/**
 * Anchored to the provider it belongs to. The previous inline editor rendered
 * below the whole list, so setting a key on the first of three providers put
 * the input off-screen.
 */
export function ProviderKeySheet({ visible, label, busy, onSubmit, onClose }: ProviderKeySheetProps) {
  const [value, setValue] = useState('');
  if (!visible) return null;

  return (
    <BaseSheet visible={visible} eyebrow="PROVIDER" title={`Key for ${label}`} onClose={onClose} closeLabel="Cancel">
      <Text variant="caption" color="tertiary">
        Stored in the Gate vault and never shown again. The Gate checks it before this sheet closes.
      </Text>
      <TextField
        value={value}
        onChangeText={setValue}
        placeholder="Paste API key"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        style={{ marginVertical: Spacing.two }}
      />
      <Button
        label={busy ? 'Checking…' : 'Save key'}
        disabled={!value || busy}
        onPress={() => {
          onSubmit(value);
          setValue('');
        }}
      />
    </BaseSheet>
  );
}
