import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { BaseSheet, Button, Divider, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

export type TlsFingerprintChangeSheetProps = {
  visible: boolean;
  /** Fingerprint trusted on first use. */
  previousFingerprint: string;
  /** Fingerprint presented by the gateway on this connect. */
  observedFingerprint: string;
  /** Label for the gateway being connected, when known. */
  gatewayLabel?: string;
  onApprove: () => void;
  onReject: () => void;
};

/**
 * Verify-on-first-use change prompt.
 *
 * A changed fingerprint blocks the connection in the provider, so this sheet is
 * the only way back to a connected state — it must offer both outcomes plainly
 * and default to the safe one. The two hashes are shown in full rather than
 * truncated: a MITM only has to match the first few characters to fool a
 * reader who is skimming.
 */
export function TlsFingerprintChangeSheet({
  visible,
  previousFingerprint,
  observedFingerprint,
  gatewayLabel,
  onApprove,
  onReject,
}: TlsFingerprintChangeSheetProps) {
  const tokens = useTokens();

  useEffect(() => {
    if (visible) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
  }, [visible]);

  if (!visible) return null;

  return (
    <BaseSheet
      visible={visible}
      eyebrow="SECURITY"
      title="Gateway identity changed"
      onClose={onReject}
      closeLabel="Stay disconnected"
    >
      <View style={styles.content}>
        <Text variant="caption" color="secondary">
          {gatewayLabel
            ? `${gatewayLabel} presented a different TLS fingerprint than the one trusted on first use.`
            : 'This gateway presented a different TLS fingerprint than the one trusted on first use.'}{' '}
          This happens after a legitimate certificate rotation — or if something is
          intercepting the connection.
        </Text>

        <View
          style={[
            styles.hashBlock,
            { backgroundColor: tokens.backgroundInset, borderColor: tokens.borderSubtle },
          ]}
        >
          <Text variant="micro" color="tertiary">
            TRUSTED
          </Text>
          <Text variant="mono" color="secondary">
            {previousFingerprint}
          </Text>
        </View>

        <View
          style={[
            styles.hashBlock,
            { backgroundColor: tokens.backgroundInset, borderColor: tokens.borderSubtle },
          ]}
        >
          <Text variant="micro" color="tertiary">
            NOW PRESENTED
          </Text>
          <Text variant="mono" color="primary">
            {observedFingerprint}
          </Text>
        </View>

        <Divider />

        <Text variant="micro" color="tertiary">
          Only approve if you rotated the certificate yourself. Approving trusts this
          fingerprint for future connections.
        </Text>

        <View style={styles.actions}>
          <Button label="Stay disconnected" variant="ghost" onPress={onReject} />
          <Button
            label="Trust new fingerprint"
            variant="secondary"
            onPress={() => {
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              onApprove();
            }}
          />
        </View>
      </View>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  content: { gap: Spacing.two },
  hashBlock: {
    gap: Spacing.half,
    padding: Spacing.two,
    borderRadius: Radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.two,
    marginTop: Spacing.two,
    flexWrap: 'wrap',
  },
});
