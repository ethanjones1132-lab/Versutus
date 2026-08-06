import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { FontFamily, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

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
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  const handleClose = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setMounted(false);
    onClose();
  };

  if (!log) return null;

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="slide"
      onRequestClose={() => {
        setMounted(false);
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
            <Pressable onPress={() => void handleClose()} hitSlop={12}>
              <Text variant="caption" color="tertiary">
                Dismiss
              </Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.logScroll}>
            <Text variant="mono" style={styles.logText}>
              {log}
            </Text>
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
    ...StyleSheet.absoluteFillObject,
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
  logScroll: {
    paddingBottom: Spacing.four,
  },
  logText: {
    fontFamily: FontFamily.mono,
    lineHeight: 18,
  },
});
