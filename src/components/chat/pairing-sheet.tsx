import { StyleSheet, View } from 'react-native';

import { PairingPanel } from '@/components/pairing-panel';
import { BaseSheet } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
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

  if (!visible) return null;

  return (
    <BaseSheet
      visible={visible}
      eyebrow="PAIRING REQUIRED"
      onClose={onDismiss}
      closeLabel="Dismiss"
      position="top"
    >
      {/* Keep custom handle for pairing visual */}
      <View style={styles.handleRow}>
        <View style={[styles.handle, { backgroundColor: tokens.borderStrong }]} />
      </View>
      <PairingPanel deviceId={deviceId} pairingDetails={pairingDetails} />
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  handleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: Spacing.two,
    paddingBottom: Spacing.one,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
});
