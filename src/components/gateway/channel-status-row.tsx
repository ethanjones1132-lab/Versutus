import { Pressable, StyleSheet, View } from 'react-native';

import { Icon, Text } from '@/components/ui';
import { Palette, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { describeChannelStatusRow } from '@/lib/gateway/channel-status';
import type { GatewayCapabilityGroup } from '@/lib/gateway/types';

/**
 * The persistent glance line Tier 2.6 asked for: channels stay visible on the
 * dashboard even when nothing is wrong, instead of surfacing only through the
 * degraded-only Channel Repair card. Tapping opens chat, where /channel and
 * its repair commands live.
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
      <Text variant="caption" color="tertiary" numberOfLines={1} style={styles.detail}>
        {model.detail}
      </Text>
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
    minHeight: 40,
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
  detail: {
    flex: 1,
    minWidth: 0,
    textAlign: 'right',
  },
});
