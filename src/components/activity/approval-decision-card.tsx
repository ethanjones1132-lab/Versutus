import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Button, Card, Icon, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { haptics } from '@/lib/haptics';
import { approvalExitDuration, nextApprovalExit, type ApprovalExit } from '@/lib/motion/approval-exit';

export function ApprovalDecisionCard({
  runId,
  prompt,
  onResolve,
}: {
  runId: string;
  prompt?: string;
  onResolve: (approved: boolean) => void;
}) {
  const tokens = useTokens();
  const [exit, setExit] = useState<ApprovalExit>('idle');
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
    const duration = approvalExitDuration(next);
    setTimeout(() => onResolve(approved), duration);
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
        <Text variant="body" numberOfLines={3}>
          {prompt}
        </Text>
        <Text variant="mono" color="tertiary" numberOfLines={1}>
          run {runId}
        </Text>
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
});
