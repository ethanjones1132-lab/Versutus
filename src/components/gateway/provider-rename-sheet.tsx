import { useState } from 'react';

import { BaseSheet, Button, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

/**
 * A `label` is the operator-facing name the Gate stores alongside the
 * provider id. The id stays lowercase and unchanged across updates -- renaming
 * it would orphan the stored credential at `provider/${id}/api-key` -- so this
 * sheet edits the label only and lets the schema validate the trimmed value
 * before the save round-trips.
 *
 * The parent (action sheet) renders this component only while open, so each
 * open is a fresh mount -- `useState(label)` seeds the field without an effect,
 * and a stale error or unsaved edit cannot carry across opens.
 */
export type ProviderRenameSheetProps = {
  label: string;
  /**
   * Send the trimmed label to the Gate. The action sheet will fire this and
   * reload the provider list on success. Rejections surface as the Gate's
   * own validation message ("label: must be a non-empty string", etc.).
   */
  onSubmit: (nextLabel: string) => Promise<void> | void;
  onClose: () => void;
};

export function ProviderRenameSheet({ label, onSubmit, onClose }: ProviderRenameSheetProps) {
  const [value, setValue] = useState(label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = value.trim();
  const canSave = !busy && trimmed.length > 0;

  async function saveRename() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BaseSheet visible eyebrow="PROVIDER" title={`Rename ${label}`} onClose={onClose} closeLabel="Cancel">
      <Text variant="caption" color="tertiary">
        Renamed on this Gate. The provider id and stored credential stay the same.
      </Text>
      <TextField
        value={value}
        onChangeText={setValue}
        placeholder="Provider label"
        autoCapitalize="sentences"
        style={{ marginVertical: Spacing.two }}
      />
      {error ? (
        <Text variant="caption" color="statusDisconnected" style={{ marginBottom: Spacing.two }}>
          {error}
        </Text>
      ) : null}
      <Button
        label={busy ? 'Saving…' : 'Save'}
        disabled={!canSave}
        onPress={() => void saveRename()}
      />
    </BaseSheet>
  );
}