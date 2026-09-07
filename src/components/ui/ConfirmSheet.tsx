import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { BaseSheet } from './BaseSheet';
import { Button } from './Button';
import { Text } from './Text';
import { Spacing } from '@/constants/tokens';

export type ConfirmSheetProps = {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  /**
   * Screen-reader busy state for the confirm Button while the confirmed
   * action is in flight (e.g. `'Disband'` -> `'Disbanding…'`). Passed
   * through into `accessibilityState` only when defined, so a plain
   * confirm never newly announces `busy`.
   */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmSheet({
  visible,
  title,
  message,
  confirmLabel,
  danger = true,
  busy,
  onCancel,
  onConfirm,
}: ConfirmSheetProps) {
  useEffect(() => {
    if (visible) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
  }, [visible]);

  return (
    <BaseSheet visible={visible} title={title} onClose={onCancel} closeLabel="Cancel">
      <View style={styles.content}>
        <Text variant="caption" color="secondary">
          {message}
        </Text>
        <View style={styles.actions}>
          <Button label="Cancel" variant="ghost" onPress={onCancel} />
          <Button
            label={confirmLabel}
            variant={danger ? 'primary' : 'secondary'}
            busy={busy}
            onPress={() => {
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              onConfirm();
            }}
          />
        </View>
      </View>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  content: { gap: Spacing.two },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
});
