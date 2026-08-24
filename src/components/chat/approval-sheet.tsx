import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BaseSheet, Button, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
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
        <TextField
          value={feedback}
          onChangeText={setFeedback}
          placeholder="Why this action is safe, or what to change…"
          multiline
          // Feedback is prose — keep the platform typing defaults; the kit's
          // form defaults (none / no autocorrect) are for URLs and tokens.
          autoCapitalize="sentences"
          autoCorrect={true}
          accessibilityLabel="Approval feedback"
          style={styles.input}
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
    // The kit owns the chrome and typography; the sheet only pins the room
    // the field gets so the bottom sheet stays compact and bounded.
    minHeight: 64,
    maxHeight: 120,
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
