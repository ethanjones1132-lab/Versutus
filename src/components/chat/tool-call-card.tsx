import { StyleSheet } from 'react-native';

import { Badge, GlassSurface, Icon, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
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
  const status = toolCall.status ?? 'complete';
  const duration =
    toolCall.durationMs != null ? `${(toolCall.durationMs / 1000).toFixed(1)}s` : undefined;

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
        <Text variant="micro" color="tertiary" numberOfLines={2} style={styles.detail}>
          {toolCall.detail}
        </Text>
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
});
