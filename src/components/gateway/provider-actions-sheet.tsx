import { Alert } from 'react-native';

import * as Haptics from 'expo-haptics';

import { BaseSheet, Divider, ListRow } from '@/components/ui';

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
}: ProviderActionsSheetProps) {
  if (!visible) return null;

  const run = (action: () => void) => () => {
    action();
    onClose();
  };

  function confirmDelete() {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert('Remove provider?', `${label} and its stored credential will be removed from the Gate.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          onDelete();
          onClose();
        },
      },
    ]);
  }

  return (
    <BaseSheet visible={visible} eyebrow="PROVIDER" title={label} onClose={onClose} closeLabel="Dismiss">
      <ListRow title="Set key" icon={{ ios: 'key', android: 'key', web: 'key' }} chevron={false} onPress={run(onSetKey)} />
      <ListRow title="Authorize" icon={{ ios: 'person.badge.key', android: 'lock_open', web: 'lock_open' }} chevron={false} onPress={run(onAuthorize)} />
      <ListRow title="Check readiness" icon={{ ios: 'stethoscope', android: 'health_and_safety', web: 'health_and_safety' }} chevron={false} onPress={run(onCheck)} />
      <ListRow title="Refresh catalog" icon={{ ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' }} chevron={false} onPress={run(onRefresh)} />
      <Divider />
      <ListRow title="Disconnect" icon={{ ios: 'link.badge.plus', android: 'link_off', web: 'link_off' }} chevron={false} onPress={run(onDisconnect)} />
      <ListRow title="Disable" icon={{ ios: 'pause.circle', android: 'pause_circle', web: 'pause_circle' }} chevron={false} onPress={run(onDisable)} />
      <ListRow title="Remove provider" icon={{ ios: 'trash', android: 'delete', web: 'delete' }} chevron={false} onPress={confirmDelete} />
    </BaseSheet>
  );
}
