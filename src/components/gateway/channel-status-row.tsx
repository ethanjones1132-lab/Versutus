import { Pressable, StyleSheet, View } from 'react-native';
import { useState } from 'react';

import { Icon, PressableScale, Text } from '@/components/ui';
import { Palette, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { describeChannelStatusRow } from '@/lib/gateway/channel-status';
import { CHIP_HIT_SLOP } from '@/lib/motion/chip-hit-slop';
import type { GatewayCapabilityGroup } from '@/lib/gateway/types';

/**
 * The persistent glance line Tier 2.6 asked for: channels stay visible on
 * the dashboard whenever the snapshot says anything about them — hidden on
 * gateways that declare none, an attention verdict when a declaring gateway
 * reports degraded bridges. Tapping opens chat, where live channel state or
 * honest host-side guidance answers.
 */
export function ChannelStatusRow({
  group,
  onPress,
}: {
  group?: GatewayCapabilityGroup;
  onPress: () => void;
}) {
  const tokens = useTokens();
  const model = describeChannelStatusRow(group);
  // Default collapsed keeps the row slim; the full degraded-bridge verdict is
  // one tap away. The toggle sits inside the row Pressable that opens chat, so
  // it stops the event from bubbling to that onPress.
  const [detailExpanded, setDetailExpanded] = useState(false);
  if (!model.visible) return null;

  const dotColor =
    model.tone === 'live'
      ? tokens.statusConnected
      : model.tone === 'attention'
        ? tokens.accentWarm
        : tokens.textTertiary;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${model.label} - ${model.detail}`}
      style={[styles.row, model.tone === 'attention' && styles.rowAttention]}>
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      <Text variant="caption" numberOfLines={1} style={styles.label}>
        {model.label}
      </Text>
      <PressableScale
        onPress={(event) => {
          event.stopPropagation();
          setDetailExpanded((prev) => !prev);
        }}
        hitSlop={CHIP_HIT_SLOP}
        accessibilityRole="button"
        accessibilityState={{ expanded: detailExpanded }}
        accessibilityLabel={
          detailExpanded ? 'Collapse channel status detail' : 'Expand channel status detail'
        }
        style={styles.detailToggle}>
        <Text variant="caption" color="tertiary" numberOfLines={detailExpanded ? undefined : 1} style={styles.detail}>
          {model.detail}
        </Text>
      </PressableScale>
      <Icon
        name={{ ios: 'chevron.forward', android: 'chevron_right', web: 'chevron_right' }}
        size={12}
        color="tertiary"
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.border,
    backgroundColor: Palette.backgroundInset,
  },
  rowAttention: {
    borderColor: Palette.accentWarm,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    color: Palette.textPrimary,
    flexShrink: 0,
  },
  detailToggle: {
    flex: 1,
    minWidth: 0,
  },
  detail: {
    flex: 1,
    minWidth: 0,
    textAlign: 'right',
  },
});
