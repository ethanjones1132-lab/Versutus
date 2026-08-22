import { useState } from 'react';

import { BaseSheet, ConfirmSheet, Divider, ListRow } from '@/components/ui';

export type EnvironmentActionsSheetProps = {
  visible: boolean;
  label: string;
  onClose: () => void;
  onCheck: () => void;
  onStart: () => void;
  onStop: () => void;
  onRun: () => void;
  onEdit: () => void;
  onRemove: () => void;
};

export function EnvironmentActionsSheet({
  visible,
  label,
  onClose,
  onCheck,
  onStart,
  onStop,
  onRun,
  onEdit,
  onRemove,
}: EnvironmentActionsSheetProps) {
  const [removeVisible, setRemoveVisible] = useState(false);

  if (!visible) return null;

  const run = (action: () => void) => () => {
    action();
    onClose();
  };

  function executeRemove() {
    onRemove();
    setRemoveVisible(false);
    onClose();
  }

  return (
    <BaseSheet visible={visible} eyebrow="ENVIRONMENT" title={label} onClose={onClose} closeLabel="Dismiss">
      <ListRow title="Check readiness" icon={{ ios: 'stethoscope', android: 'health_and_safety', web: 'health_and_safety' }} chevron={false} onPress={run(onCheck)} />
      <ListRow title="Start" icon={{ ios: 'play.circle', android: 'play_circle', web: 'play_circle' }} chevron={false} onPress={run(onStart)} />
      <ListRow title="Stop" icon={{ ios: 'stop.circle', android: 'stop_circle', web: 'stop_circle' }} chevron={false} onPress={run(onStop)} />
      <ListRow title="Run task" icon={{ ios: 'terminal', android: 'terminal', web: 'terminal' }} chevron={false} onPress={run(onRun)} />
      <ListRow title="Edit settings" icon={{ ios: 'pencil', android: 'edit', web: 'edit' }} chevron={false} onPress={run(onEdit)} />
      <Divider />
      <ListRow title="Remove environment" icon={{ ios: 'trash', android: 'delete', web: 'delete' }} chevron={false} onPress={() => setRemoveVisible(true)} />

      <ConfirmSheet
        visible={removeVisible}
        title="Remove environment?"
        message={`${label} will be removed from this Gate. Runs already recorded stay in history.`}
        confirmLabel="Remove"
        danger
        onCancel={() => setRemoveVisible(false)}
        onConfirm={executeRemove}
      />
    </BaseSheet>
  );
}
