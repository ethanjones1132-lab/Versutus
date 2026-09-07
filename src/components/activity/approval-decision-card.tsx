import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Button, Card, Icon, PressableScale, Text, TextField } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { haptics } from '@/lib/haptics';
import { approvalExitDuration, nextApprovalExit, type ApprovalExit } from '@/lib/motion/approval-exit';
import { CHIP_HIT_SLOP } from '@/lib/motion/chip-hit-slop';

export function ApprovalDecisionCard({
  runId,
  prompt,
  onResolve,
}: {
  runId: string;
  prompt?: string;
  /**
   * `feedback` is carried by Deny only and may be an empty string — an
   * empty Deny is a valid decision. Approve never sends feedback.
   */
  onResolve: (approved: boolean, feedback?: string) => void;
}) {
  const tokens = useTokens();
  const [exit, setExit] = useState<ApprovalExit>('idle');
  // Default collapsed keeps the card compact; the full prompt is one tap away.
  const [promptExpanded, setPromptExpanded] = useState(false);
  // The operator's reply to the run's "Approve this?" question. Tracked
  // here, surfaced on the Deny path only — Approve ignores it. Trimmed at
  // hand-off so the gateway never sees stray whitespace.
  const [feedbackText, setFeedbackText] = useState('');
  const locked = useRef(false);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);
  const borderProgress = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
    borderColor: borderProgress.value > 0.5 ? tokens.statusDisconnected : tokens.accentWarm,
  }));

  const decide = (approved: boolean) => {
    if (locked.current) return;
    const next = nextApprovalExit(exit, approved ? 'approve' : 'deny');
    if (next === exit) return;
    locked.current = true;
    setExit(next);
    if (approved) {
      void haptics.success();
      // eslint-disable-next-line react-hooks/immutability
      scale.value = withTiming(0.92, { duration: approvalExitDuration('approving') });
      // eslint-disable-next-line react-hooks/immutability
      opacity.value = withTiming(0, { duration: approvalExitDuration('approving') });
    } else {
      void haptics.warning();
      // eslint-disable-next-line react-hooks/immutability
      borderProgress.value = withTiming(1, { duration: approvalExitDuration('denying') });
    }
    // Approve never carries feedback. Deny trims the operator's reply so the
    // gateway never receives a whitespace-only payload — but an empty trim
    // is forwarded as '' (a valid "deny, no comment"), not dropped.
    const trimmed = feedbackText.trim();
    const feedback = approved ? undefined : trimmed;
    const duration = approvalExitDuration(next);
    setTimeout(() => onResolve(approved, feedback), duration);
  };

  const busy = exit !== 'idle';

  return (
    <Animated.View style={animatedStyle}>
      <Card variant="hero" padding={Spacing.three} style={styles.card}>
        <View style={styles.header}>
          <Icon
            name={{ ios: 'hand.raised.fill', android: 'pan_tool', web: 'pan_tool' }}
            size={16}
            color="accentWarm"
          />
          <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
            Approval requested
          </Text>
        </View>
        <PressableScale
          onPress={() => {
            void haptics.light();
            setPromptExpanded((prev) => !prev);
          }}
          hitSlop={CHIP_HIT_SLOP}
          accessibilityRole="button"
          accessibilityState={{ expanded: promptExpanded }}
          accessibilityLabel={promptExpanded ? 'Collapse run prompt' : 'Expand run prompt'}>
          <Text variant="body" numberOfLines={promptExpanded ? undefined : 3}>
            {prompt}
          </Text>
        </PressableScale>
        <Text variant="mono" color="tertiary" numberOfLines={1}>
          run {runId}
        </Text>
        {/* The reply field is always rendered (until the card exits) so a
            Approve-with-no-comment and a Deny-with-no-comment share the
            same layout. Approve ignores its value; only Deny forwards it. */}
        <View style={styles.feedbackBlock}>
          <Text variant="caption" color="secondary">
            Reply (Deny only — Approve ignores this)
          </Text>
          <TextField
            value={feedbackText}
            onChangeText={setFeedbackText}
            placeholder="Tell the run what to do instead…"
            multiline
            // The reply is prose to a model — sentences/corrections, not
            // a URL or token, so the kit's form defaults would over-correct.
            autoCapitalize="sentences"
            autoCorrect
            editable={!busy}
            accessibilityLabel="Deny reply"
          />
        </View>
        <View style={styles.actions}>
          <Button label="Approve" onPress={() => decide(true)} disabled={busy} style={styles.button} />
          <Button
            label="Deny"
            variant="destructive"
            onPress={() => decide(false)}
            disabled={busy}
            style={styles.button}
          />
        </View>
      </Card>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
    gap: Spacing.two,
    marginBottom: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  eyebrow: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  button: {
    flex: 1,
  },
  feedbackBlock: {
    gap: Spacing.one,
  },
});
