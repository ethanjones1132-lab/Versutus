import { useState } from 'react';

import { Button, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

export function ProviderEditor({
  onSubmit,
}: {
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <>
      <Text variant="caption">API key is stored in the Gate vault and never shown again.</Text>
      <TextField
        value={value}
        onChangeText={setValue}
        placeholder="Paste API key"
        secureTextEntry
        style={{ marginVertical: Spacing.two }}
      />
      <Button label="Save key" onPress={() => { onSubmit(value); setValue(''); }} disabled={!value} />
    </>
  );
}
