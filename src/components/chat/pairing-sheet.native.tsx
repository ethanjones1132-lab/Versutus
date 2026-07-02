import {
  BottomSheet,
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetMethods,
} from '@expo/ui/community/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { PairingPanel } from '@/components/pairing-panel';
import { PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { PairingDetails } from '@/lib/gateway/types';

export function PairingSheet({
  visible,
  deviceId,
  pairingDetails,
  onDismiss,
}: {
  visible: boolean;
  deviceId: string;
  pairingDetails?: PairingDetails | null;
  onDismiss?: () => void;
}) {
  const tokens = useTokens();
  const sheetRef = useRef<BottomSheetMethods>(null);

  useEffect(() => {
    if (visible && deviceId) {
      sheetRef.current?.present();
      return;
    }
    sheetRef.current?.dismiss();
  }, [deviceId, visible]);

  if (!deviceId) return null;

  return (
    <BottomSheet
      ref={sheetRef}
      index={0}
      snapPoints={['52%', '88%']}
      enablePanDownToClose
      onClose={onDismiss}
      backgroundStyle={[
        styles.sheetBackground,
        {
          backgroundColor: tokens.backgroundElevated,
          borderColor: tokens.accentWarmMuted,
        },
      ]}
      handleIndicatorStyle={{ backgroundColor: tokens.borderStrong }}>
      <BottomSheetView style={styles.sheetContent}>
        <View style={styles.header}>
          <Text variant="mono" color="accentWarm" style={styles.eyebrow}>
            PAIRING REQUIRED
          </Text>
          {onDismiss ? (
            <PressableScale
              onPress={async () => {
                await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onDismiss();
              }}
              hitSlop={12}>
              <Text variant="caption" color="tertiary">
                Dismiss
              </Text>
            </PressableScale>
          ) : null}
        </View>
        <BottomSheetScrollView contentContainerStyle={styles.scroll}>
          <PairingPanel deviceId={deviceId} pairingDetails={pairingDetails} />
        </BottomSheetScrollView>
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheetBackground: {
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
  },
  sheetContent: {
    flex: 1,
    gap: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.one,
  },
  eyebrow: {
    letterSpacing: 1,
  },
  scroll: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.five,
  },
});
