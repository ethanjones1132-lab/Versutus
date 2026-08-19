import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { BaseSheet, Button, Text } from '@/components/ui';
import { FontFamily, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { haptics } from '@/lib/haptics';

export function ApprovalSheet({
  visible,
  runId,
  prompt,
  gatewayName,
  onApprove,
  onDeny,
}: {
  visible: boolean;
  runId?: string;
  prompt?: string;
  gatewayName?: string;
  onApprove: (feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}) {
  const tokens = useTokens();
  const [feedback, setFeedback] = useState('');

  if (!visible || !runId) return null;

  return (
    <BaseSheet
      visible={visible}
      eyebrow="APPROVAL REQUIRED"
      onClose={() => onDeny(feedback.trim() || undefined)}
      closeLabel="Deny"
      position="bottom">
      <Text variant="title">Approve this agent action?</Text>

      {gatewayName ? (
        <Text variant="caption" color="tertiary" style={styles.meta}>
          {gatewayName} · run {runId.slice(0, 12)}…
        </Text>
      ) : null}

      <Text color="secondary" style={styles.summary}>
        {prompt || 'The agent is requesting permission to proceed.'}
      </Text>

      <View style={styles.feedback}>
        <Text variant="caption" color="tertiary">
          Feedback (optional)
        </Text>
        <TextInput
          style={[
            styles.input,
            {
              color: tokens.textPrimary,
              backgroundColor: tokens.backgroundInset,
              borderColor: tokens.glassBorder,
            },
          ]}
          value={feedback}
          onChangeText={setFeedback}
          placeholder="Why this action is safe, or what to change…"
          placeholderTextColor={tokens.textTertiary}
          multiline
        />
      </View>

      <View style={styles.footer}>
        <Button
          label="Deny"
          variant="secondary"
          onPress={async () => {
            await haptics.warning();
            onDeny(feedback.trim() || undefined);
          }}
          style={styles.footerButton}
        />
        <Button
          label="Approve"
          onPress={async () => {
            await haptics.success();
            onApprove(feedback.trim() || undefined);
          }}
          style={styles.footerPrimary}
        />
      </View>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  meta: {
    marginTop: Spacing.one,
  },
  summary: {
    marginTop: Spacing.two,
    lineHeight: 20,
  },
  feedback: {
    gap: Spacing.one,
    marginTop: Spacing.three,
  },
  input: {
    minHeight: 64,
    maxHeight: 120,
    fontSize: 13,
    fontFamily: FontFamily.sans,
    padding: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    textAlignVertical: 'top',
  },
  footer: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingTop: Spacing.three,
    marginTop: Spacing.two,
  },
  footerButton: {
    flex: 1,
  },
  footerPrimary: {
    flex: 2,
  },
});
