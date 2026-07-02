import * as Haptics from 'expo-haptics';
import {
  BottomSheet,
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetMethods,
} from '@expo/ui/community/bottom-sheet';
import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { FontFamily, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

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
  const sheetRef = useRef<BottomSheetMethods>(null);

  useEffect(() => {
    if (visible && log) {
      sheetRef.current?.present();
      return;
    }
    sheetRef.current?.dismiss();
  }, [log, visible]);

  const handleClose = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };

  if (!log) return null;

  return (
    <BottomSheet
      ref={sheetRef}
      index={0}
      snapPoints={['35%', '70%']}
      enablePanDownToClose
      onClose={handleClose}
      backgroundStyle={[
        styles.sheetBackground,
        {
          backgroundColor: tokens.backgroundElevated,
        },
      ]}
      handleIndicatorStyle={{ backgroundColor: tokens.borderStrong }}>
      <BottomSheetView style={styles.sheetContent}>
        <View style={styles.header}>
          <Text variant="caption" color="secondary">Command output</Text>
          <Pressable onPress={handleClose} hitSlop={12}>
            <Text variant="caption" color="tertiary">Dismiss</Text>
          </Pressable>
        </View>
        <BottomSheetScrollView contentContainerStyle={styles.logScroll}>
          <Text variant="mono" style={styles.logText}>
            {log}
          </Text>
        </BottomSheetScrollView>
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheetBackground: {
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
  },
  sheetContent: {
    flex: 1,
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
    gap: Spacing.two,
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