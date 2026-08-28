import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Badge, GlassSurface, Icon, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { CHIP_HIT_SLOP } from '@/lib/motion/chip-hit-slop';
import type { ChatToolCall } from '@/lib/gateway/types';

const STATUS_TONE = {
  running: 'warning',
  complete: 'success',
  error: 'danger',
} as const;

const STATUS_LABEL = {
  running: 'Running',
  complete: 'Done',
  error: 'Failed',
} as const;

/** Compact status row for a tool invocation attached to a chat message. */
export function ToolCallCard({ toolCall }: { toolCall: ChatToolCall }) {
  const tokens = useTokens();
  const status = toolCall.status ?? 'complete';
  const duration =
    toolCall.durationMs != null ? `${(toolCall.durationMs / 1000).toFixed(1)}s` : undefined;
  // A failed call's two-line-clipped detail is the only failure information
  // the app has, so it falls back to expanded; the user's own choice wins
  // once made. Derived (not a mount snapshot) so a call that transitions
  // running -> error mid-stream opens by itself.
  const [detailUserOverride, setDetailUserOverride] = useState<boolean | null>(null);
  const isDetailExpanded = toolCall.detail
    ? detailUserOverride !== null
      ? detailUserOverride
      : toolCall.status === 'error'
    : false;

  return (
    <GlassSurface variant="inset" radius={Radius.md} padding={Spacing.two} style={styles.card}>
      <Icon
        name={{ ios: 'wrench.and.screwdriver', android: 'build', web: 'build' }}
        size={13}
        color="accentWarm"
      />
      <Text variant="mono" color="secondary" numberOfLines={1} style={styles.name}>
        {toolCall.name}
      </Text>
      {duration ? (
        <Text variant="micro" color="tertiary">
          {duration}
        </Text>
      ) : null}
      <Badge label={STATUS_LABEL[status]} tone={STATUS_TONE[status]} dot={false} />
      {toolCall.detail ? (
        <View style={styles.detailSection}>
          <PressableScale
            onPress={async () => {
              await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setDetailUserOverride((prev) => (prev !== null ? !prev : status !== 'error'));
            }}
            hitSlop={CHIP_HIT_SLOP}
            style={styles.detailToggle}>
            <Text variant="caption" color="accent">
              {isDetailExpanded ? 'Hide detail' : 'Detail'}
            </Text>
          </PressableScale>
          {isDetailExpanded ? (
            <View
              style={[
                styles.detailCard,
                {
                  backgroundColor: tokens.backgroundInset,
                  borderColor: tokens.glassBorder,
                },
              ]}>
              <ScrollView style={styles.detailScroll} nestedScrollEnabled>
                <Text variant="micro" color="tertiary">
                  {toolCall.detail}
                </Text>
              </ScrollView>
            </View>
          ) : (
            <Text variant="micro" color="tertiary" numberOfLines={2} style={styles.detail}>
              {toolCall.detail}
            </Text>
          )}
        </View>
      ) : null}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  name: {
    flexShrink: 1,
  },
  detail: {
    flexBasis: '100%',
  },
  detailSection: {
    flexBasis: '100%',
    gap: Spacing.two,
  },
  detailToggle: {
    alignSelf: 'flex-start',
    minHeight: 28,
    justifyContent: 'center',
  },
  detailCard: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.two,
    maxHeight: 220,
  },
  detailScroll: {
    maxHeight: 200,
  },
});