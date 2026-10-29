import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BaseSheet, Button, Divider, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { haptics } from '@/lib/haptics';

export type TlsFingerprintChangeSheetProps = {
  visible: boolean;
  /** Fingerprint trusted on first use. */
  previousFingerprint: string;
  /** Fingerprint presented by the gateway on this connect. */
  observedFingerprint: string;
  /** Label for the gateway being connected, when known. */
  gatewayLabel?: string;
  gatewayId?: string;
  /** Why the previous approval attempt did not persist, in plain words. */
  error?: string;
  /** An approval write for this prompt is already in flight. */
  pending?: boolean;
  /**
   * Runs the approval. It must resolve only when the decision is persisted;
   * a failure leaves this sheet open with `error`, so the operator can retry.
   */
  onApprove: () => void | Promise<void>;
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
  gatewayId,
  error,
  pending = false,
  onApprove,
  onReject,
}: TlsFingerprintChangeSheetProps) {
  const tokens = useTokens();
  const [approving, setApproving] = useState(false);
  const promptKey = JSON.stringify([visible, gatewayId, previousFingerprint, observedFingerprint]);
  const [previousPromptKey, setPreviousPromptKey] = useState(promptKey);
  if (promptKey !== previousPromptKey) {
    setPreviousPromptKey(promptKey);
    if (visible) setApproving(false);
  }
  // State alone cannot stop a second tap in the same tick, before the busy
  // render lands. The ref is the synchronous gate; the provider has its own
  // attempt key as the durable one.
  const approvingRef = useRef<object | null>(null);
  const busy = pending || approving;

  useEffect(() => {
    if (visible) {
      void haptics.warning();
    }
  }, [visible]);

  // A different prompt is a different decision: the previous attempt's busy
  // state must not keep the new decision's Trust button disabled while the old
  // write settles.
  useEffect(() => {
    if (!visible) return;
    approvingRef.current = null;
  }, [visible, gatewayId, previousFingerprint, observedFingerprint]);

  const approve = async () => {
    if (approvingRef.current || pending) return;
    const attempt = {};
    approvingRef.current = attempt;
    setApproving(true);
    try {
      await onApprove();
      // Only a persisted decision gets the success haptic. A refusal leaves
      // the sheet open with its reason and the button ready to try again.
      if (approvingRef.current === attempt) void haptics.success();
    } catch {
      // The provider owns the plain error on this prompt; a success signal
      // here would contradict the failure it just reported.
    } finally {
      if (approvingRef.current === attempt) {
        approvingRef.current = null;
        setApproving(false);
      }
    }
  };

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

        {error ? (
          <Text variant="caption" color="statusDisconnected" selectable>
            {error}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <Button label="Stay disconnected" variant="ghost" onPress={() => {
            approvingRef.current = null;
            setApproving(false);
            onReject();
          }} />
          <Button
            label="Trust new fingerprint"
            variant="secondary"
            disabled={busy}
            busy={busy}
            onPress={approve}
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
