import { useState } from 'react';

import { ProviderRenameSheet } from '@/components/gateway/provider-rename-sheet';
import { BaseSheet, ConfirmSheet, Divider, ListRow } from '@/components/ui';

export type ProviderActionsSheetProps = {
  visible: boolean;
  label: string;
  onClose: () => void;
  onSetKey: () => void;
  onAuthorize: () => void;
  onCheck: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
  onDisable: () => void;
  onDelete: () => void;
  /**
   * Submit a renamed label to the Gate. The action sheet does not know how
   * the rename is implemented -- the parent sends `providers.update({id, label})`
   * and reloads -- so the operator's typed value is the only argument that
   * crosses this boundary.
   */
  onRename: (nextLabel: string) => Promise<void> | void;
};

export function ProviderActionsSheet({
  visible,
  label,
  onClose,
  onSetKey,
  onAuthorize,
  onCheck,
  onRefresh,
  onDisconnect,
  onDisable,
  onDelete,
  onRename,
}: ProviderActionsSheetProps) {
  const [deleteVisible, setDeleteVisible] = useState(false);
  const [renameVisible, setRenameVisible] = useState(false);

  if (!visible) return null;

  const run = (action: () => void) => () => {
    action();
    onClose();
  };

  function openRename() {
    setRenameVisible(true);
  }

  function closeRename() {
    setRenameVisible(false);
  }

  function confirmDelete() {
    setDeleteVisible(true);
  }

  function executeDelete() {
    onDelete();
    setDeleteVisible(false);
    onClose();
  }

  return (
    <BaseSheet visible={visible} eyebrow="PROVIDER" title={label} onClose={onClose} closeLabel="Dismiss">
      <ListRow title="Rename" icon={{ ios: 'pencil', android: 'edit', web: 'edit' }} chevron={false} onPress={openRename} />
      <ListRow title="Set key" icon={{ ios: 'key', android: 'key', web: 'key' }} chevron={false} onPress={run(onSetKey)} />
      <ListRow title="Authorize" icon={{ ios: 'person.badge.key', android: 'lock_open', web: 'lock_open' }} chevron={false} onPress={run(onAuthorize)} />
      <ListRow title="Check readiness" icon={{ ios: 'stethoscope', android: 'health_and_safety', web: 'health_and_safety' }} chevron={false} onPress={run(onCheck)} />
      <ListRow title="Refresh catalog" icon={{ ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' }} chevron={false} onPress={run(onRefresh)} />
      <Divider />
      <ListRow title="Disconnect" icon={{ ios: 'link.badge.plus', android: 'link_off', web: 'link_off' }} chevron={false} onPress={run(onDisconnect)} />
      <ListRow title="Disable" icon={{ ios: 'pause.circle', android: 'pause_circle', web: 'pause_circle' }} chevron={false} onPress={run(onDisable)} />
      <ListRow title="Remove provider" icon={{ ios: 'trash', android: 'delete', web: 'delete' }} chevron={false} onPress={confirmDelete} />

      <ConfirmSheet
        visible={deleteVisible}
        title="Remove provider?"
        message={`${label} and its stored credential will be removed from the Gate.`}
        confirmLabel="Remove"
        danger
        onCancel={() => setDeleteVisible(false)}
        onConfirm={executeDelete}
      />

      {renameVisible ? (
        <ProviderRenameSheet
          label={label}
          onSubmit={onRename}
          onClose={closeRename}
        />
      ) : null}
    </BaseSheet>
  );
}