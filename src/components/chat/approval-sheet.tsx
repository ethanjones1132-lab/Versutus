import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { BaseSheet, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

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
      onClose={onDeny}
      closeLabel="Deny"
      position="bottom"
    >
      <Text variant="title" style={styles.title}>
        Approve this agent action?
      </Text>

      {gatewayName ? (
        <Text variant="caption" color="tertiary">
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
          style={[styles.input, { color: tokens.textPrimary }]}
          value={feedback}
          onChangeText={setFeedback}
          placeholder="Why this action is safe, or what to change…"
          placeholderTextColor={tokens.textTertiary}
          multiline
        />
      </View>

      <View style={styles.footer}>
        <PressableScale
          style={styles.denyBtn}
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onDeny(feedback.trim() || undefined);
          }}>
          <Text variant="caption">Deny</Text>
        </PressableScale>
        <PressableScale
          style={[styles.approveBtn, { backgroundColor: tokens.accentWarm }]}
          onPress={async () => {
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            onApprove(feedback.trim() || undefined);
          }}>
          <Text variant="caption" style={styles.approveLabel}>
            Approve
          </Text>
        </PressableScale>
      </View>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  title: {
    color: '#fff',
  },
  summary: {
    fontSize: 15,
    lineHeight: 20,
    marginTop: Spacing.one,
  },
  feedback: {
    gap: Spacing.one,
    marginTop: Spacing.two,
  },
  input: {
    minHeight: 64,
    maxHeight: 120,
    fontSize: 13,
    padding: Spacing.two,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(240,214,144,0.2)',
    textAlignVertical: 'top',
  },
  footer: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingTop: Spacing.three,
    marginTop: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(240,214,144,0.2)',
  },
  denyBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.two,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  approveBtn: {
    flex: 2,
    alignItems: 'center',
    paddingVertical: Spacing.two,
    borderRadius: 10,
  },
  approveLabel: {
    color: '#111',
  },
});
