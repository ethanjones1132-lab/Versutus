import { memo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { PulsingDot, statusColor } from '@/components/connection-badge';
import { Chip, GlassSurface, Icon, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { ConnectionStatus } from '@/lib/gateway/types';
import {
  chatHeaderChipLayout,
  chatHeaderChipMaxWidth,
  chatHeaderSessionChip,
  chatHeaderTitle,
} from '@/lib/motion/chat-header-layout';

export type ChatHeaderProps = {
  gatewayName: string;
  status: ConnectionStatus;
  statusDetail?: string;
  streaming?: boolean;
  sessionLabel?: string;
  modelLabel?: string;
  onSessionPress?: () => void;
  onModelPress?: () => void;
  onOverflowPress?: () => void;
  /** Present only when the gateway advertises chat backends. */
  backendLabel?: string;
  /** Group room name. Titles the header; rooms have no session chip. */
  groupName?: string;
  onBackendPress?: () => void;
  onRosterPress?: () => void;
  /** True while the backends section of the thread config sheet is open. */
  backendsExpanded?: boolean;
  /** True while the chat overflow sheet is open. */
  overflowExpanded?: boolean;
};

/** Slim contextual chat header: orb, gateway, quick model/session chips, overflow. */
function ChatHeaderImpl({
  gatewayName,
  status,
  statusDetail,
  streaming = false,
  sessionLabel,
  modelLabel,
  onSessionPress,
  onModelPress,
  onOverflowPress,
  backendLabel,
  groupName,
  onBackendPress,
  onRosterPress,
  backendsExpanded,
  overflowExpanded,
}: ChatHeaderProps) {
  const tokens = useTokens();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const color = statusColor(tokens, status);
  const pulsing = streaming || status === 'connecting' || status === 'reconnecting' || status === 'pairing';
  const title = chatHeaderTitle({ gatewayName, backendLabel, groupName });
  const showModel = Boolean(modelLabel && onModelPress);
  const showSession = chatHeaderSessionChip(
    groupName?.trim()
      ? { surface: 'group' }
      : { surface: 'thread', sessionLabel, sessionPress: Boolean(onSessionPress) },
  );
  const stacked =
    chatHeaderChipLayout({
      windowWidth,
      fontScale,
      model: showModel,
      session: showSession,
    }) === 'stacked';
  const chipMaxWidth = chatHeaderChipMaxWidth(fontScale);

  const orb = (
    <View style={[styles.orbHalo, { borderColor: tokens.glassBorder }]}>
      <PulsingDot color={color} active={pulsing} />
    </View>
  );
  const back = onRosterPress ? (
    <PressableScale
      onPress={onRosterPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel="Back to roster"
      style={styles.overflow}>
      <Icon
        name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
        size={18}
        color="textSecondary"
      />
    </PressableScale>
  ) : null;
  const titles = (
    <PressableScale
      onPress={onBackendPress}
      disabled={!onBackendPress || !backendLabel}
      accessibilityRole={backendLabel && onBackendPress ? 'button' : undefined}
      accessibilityLabel={backendLabel ? `Chat backend: ${backendLabel}. Change backend.` : undefined}
      accessibilityState={{ disabled: !onBackendPress || !backendLabel, expanded: backendsExpanded ?? false }}
      style={styles.titles}>
      <Text variant="headline" numberOfLines={1} style={styles.name}>
        {title}
      </Text>
      <Text variant="micro" color="secondary" numberOfLines={1}>
        {streaming
          ? 'Streaming response…'
          : backendLabel || groupName?.trim()
            ? `via ${gatewayName}${statusDetail ? ` · ${statusDetail}` : ''}`
            : statusDetail || 'Ready for chat and slash commands'}
      </Text>
    </PressableScale>
  );
  const modelChip =
    modelLabel && onModelPress ? (
      <Chip
        label={modelLabel}
        icon={{ ios: 'cpu', android: 'memory', web: 'memory' }}
        onPress={onModelPress}
        style={[styles.chip, { maxWidth: chipMaxWidth }]}
      />
    ) : null;
  const sessionChip =
    showSession && sessionLabel && onSessionPress ? (
      <Chip
        label={sessionLabel}
        icon={{ ios: 'bubble.left.and.bubble.right', android: 'chat', web: 'chat' }}
        onPress={onSessionPress}
        style={[styles.chip, { maxWidth: chipMaxWidth }]}
      />
    ) : null;
  const overflow = onOverflowPress ? (
    <PressableScale
      onPress={onOverflowPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel="Chat options"
      accessibilityState={{ expanded: overflowExpanded ?? false }}
      style={styles.overflow}>
      <Icon
        name={{ ios: 'ellipsis', android: 'more_vert', web: 'more_vert' }}
        size={18}
        color="textSecondary"
      />
    </PressableScale>
  ) : null;

  return (
    <View style={styles.wrap}>
      <GlassSurface
        variant="hero"
        radius={Radius.xl}
        padding={Spacing.two}
        style={[styles.card, stacked && styles.cardStacked]}>
        {stacked ? (
          <>
            <View style={styles.row}>
              {orb}
              {back}
              {titles}
              {overflow}
            </View>
            <View style={styles.chipRow}>
              {modelChip}
              {sessionChip}
            </View>
          </>
        ) : (
          <>
            {orb}
            {back}
            {titles}
            {modelChip}
            {sessionChip}
            {overflow}
          </>
        )}
      </GlassSurface>
    </View>
  );
}

export const ChatHeader = memo(ChatHeaderImpl);
ChatHeader.displayName = 'ChatHeader';

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  cardStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    minWidth: 0,
    alignSelf: 'stretch',
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: Spacing.two,
  },
  orbHalo: {
    width: 34,
    height: 34,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  titles: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  name: {
    fontSize: 17,
    lineHeight: 22,
  },
  chip: {
    // maxWidth is set dynamically via chatHeaderChipMaxWidth(fontScale) so large
    // system fonts do not force a 120px pill to clip off-screen.
  },
  overflow: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
