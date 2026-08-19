import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import { CommandResultView } from './command-result-view';

// Pure-RN bottom sheet (Modal) — replaces the @expo/ui native bottom
// sheet, which crashed native builds under the New Architecture.

export function CommandLogSheet({
  visible,
  log,
  onClose,
}: {
  visible: boolean;
  log: string;
  onClose: () => void;
}) {
  const tokens = useTokens();

  const handleClose = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };

  const copyAll = async () => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await Clipboard.setStringAsync(log);
  };

  if (!log) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={() => {
        onClose();
      }}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTouch} onPress={() => void handleClose()} />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: tokens.backgroundElevated,
            },
          ]}>
          <View style={styles.header}>
            <Text variant="caption" color="secondary">
              Command output
            </Text>
            <View style={styles.headerActions}>
              <Pressable onPress={() => void copyAll()} hitSlop={12} accessibilityRole="button">
                <Text variant="caption" color="accentWarm">
                  Copy
                </Text>
              </Pressable>
              <Pressable onPress={() => void handleClose()} hitSlop={12}>
                <Text variant="caption" color="tertiary">
                  Dismiss
                </Text>
              </Pressable>
            </View>
          </View>

          <ScrollView contentContainerStyle={styles.logScroll}>
            <CommandResultView log={log} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  backdropTouch: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  sheet: {
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
    paddingTop: Spacing.two,
    gap: Spacing.two,
    maxHeight: '75%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: Spacing.one,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  logScroll: {
    paddingBottom: Spacing.four,
  },
});
