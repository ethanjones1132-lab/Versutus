import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { GlassSurface, Icon, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { chatHeaderSubtitle, chatHeaderTitle } from '@/lib/motion/chat-header-layout';

export type ChatHeaderProps = {
  gatewayName: string;
  /** Connection detail line, shown only while the gateway is not connected. */
  statusDetail?: string;
  /** Model name for this thread. Drawn as the tappable subtitle. */
  modelLabel?: string;
  onModelPress?: () => void;
  onOverflowPress?: () => void;
  /** Present only when the gateway advertises chat backends. */
  backendLabel?: string;
  /** Group room name. Titles the header; rooms have no model subtitle. */
  groupName?: string;
  onBackendPress?: () => void;
  onRosterPress?: () => void;
  /** True while the backends section of the thread config sheet is open. */
  backendsExpanded?: boolean;
  /** True while the chat overflow sheet is open. */
  overflowExpanded?: boolean;
};

/**
 * The one-row chat header: back · title with the model as its tappable
 * subtitle · one menu. Session, speaker, connection status and settings all
 * live behind that menu (chat-overflow-sheet.tsx), so nothing here stacks to
 * a second row and no chip competes with the title for phone width.
 */
function ChatHeaderImpl({
  gatewayName,
  statusDetail,
  modelLabel,
  onModelPress,
  onOverflowPress,
  backendLabel,
  groupName,
  onBackendPress,
  onRosterPress,
  backendsExpanded,
  overflowExpanded,
}: ChatHeaderProps) {
  const title = chatHeaderTitle({ gatewayName, backendLabel, groupName });
  const showModel = Boolean(modelLabel && onModelPress);
  const subtitle = chatHeaderSubtitle({
    gatewayName,
    modelLabel,
    modelPress: showModel,
    backendLabel,
    groupName,
    statusDetail,
  });

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
    <View style={styles.titles}>
      <PressableScale
        onPress={onBackendPress}
        disabled={!onBackendPress || !backendLabel}
        accessibilityRole={backendLabel && onBackendPress ? 'button' : undefined}
        accessibilityLabel={backendLabel ? `Chat backend: ${backendLabel}. Change backend.` : undefined}
        accessibilityState={{ disabled: !onBackendPress || !backendLabel, expanded: backendsExpanded ?? false }}
        style={styles.titlePress}>
        <Text variant="headline" numberOfLines={1} style={styles.name}>
          {title}
        </Text>
      </PressableScale>
      <PressableScale
        onPress={onModelPress}
        disabled={!showModel}
        hitSlop={8}
        accessibilityRole={showModel ? 'button' : undefined}
        accessibilityLabel={showModel ? `Model: ${modelLabel}. Change model.` : undefined}
        style={styles.titlePress}>
        <Text variant="micro" color="secondary" numberOfLines={1}>
          {subtitle}
        </Text>
      </PressableScale>
    </View>
  );
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
        style={styles.card}>
        {back}
        {titles}
        {overflow}
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
  titles: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  titlePress: {
    alignSelf: 'stretch',
    justifyContent: 'center',
  },
  name: {
    fontSize: 17,
    lineHeight: 22,
  },
  overflow: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
