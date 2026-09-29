import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { BotAvatar, GroupAvatar } from '@/components/chat/bot-avatar';
import { Icon, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
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
  /** The room's members, for the header crest. */
  groupMemberIds?: string[];
  onBackendPress?: () => void;
  onRosterPress?: () => void;
  /** Opens the side drawer from the roster (no back chevron). */
  onMenuPress?: () => void;
  /** True while the backends section of the thread config sheet is open. */
  backendsExpanded?: boolean;
  /** True while the chat overflow sheet is open. */
  overflowExpanded?: boolean;
  /** The Bot this thread talks to — draws its crest beside the name. */
  botId?: string;
  /** Opens the Bot's own panel (voice, skills, tools, routines) from its name. */
  onBotPress?: () => void;
  /** The Bot is working on a reply: its figure looks up and away, lit round. */
  botThinking?: boolean;
  /**
   * The roster draws its own large greeting under the header, so the header
   * there is only its two controls: no title competes with the greeting.
   */
  titleHidden?: boolean;
  /**
   * What this thread has cost ("18k · $0.42"). Rides the subtitle line after
   * the model, so the header stays one row instead of growing a glance
   * beneath it.
   */
  spendNote?: string;
};

/**
 * The one-row chat header, flat on the stage: menu-or-back · crest, title and
 * the model as its tappable subtitle · one overflow menu. On the roster the
 * leading control opens the side drawer; in a thread it returns to the
 * roster. Session, speaker, connection status and settings all live behind
 * the overflow menu (chat-overflow-sheet.tsx), so nothing here stacks to a
 * second row and no chip competes with the title for phone width.
 */
function ChatHeaderImpl({
  gatewayName,
  statusDetail,
  modelLabel,
  onModelPress,
  onOverflowPress,
  backendLabel,
  groupName,
  groupMemberIds,
  onBackendPress,
  onRosterPress,
  onMenuPress,
  backendsExpanded,
  overflowExpanded,
  botId,
  onBotPress,
  titleHidden = false,
  spendNote,
  botThinking = false,
}: ChatHeaderProps) {
  const tokens = useTokens();
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

  const leading = onRosterPress ? (
    <PressableScale
      onPress={onRosterPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel="Back to roster"
      style={styles.control}>
      <Icon
        name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
        size={20}
        color="textPrimary"
      />
    </PressableScale>
  ) : onMenuPress ? (
    <PressableScale
      onPress={onMenuPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel="Open navigation menu"
      style={styles.control}>
      <Icon
        name={{ ios: 'line.3.horizontal', android: 'menu', web: 'menu' }}
        size={20}
        color="textPrimary"
      />
    </PressableScale>
  ) : null;

  const crest = groupName && groupMemberIds?.length ? (
    <GroupAvatar memberIds={groupMemberIds} size={30} />
  ) : botId ? (
    <BotAvatar botId={botId} name={backendLabel} size={30} mood={botThinking ? 'thinking' : 'idle'} />
  ) : null;

  const titles = titleHidden ? (
    <View style={styles.titles} />
  ) : (
    <View style={styles.identity}>
      {crest}
      <View style={styles.titles}>
        {botId && onBotPress ? (
          // A Bot's name opens the Bot's own panel. A plain door: the panel
          // is a sheet with its own title, so there is no state to announce.
          <PressableScale
            onPress={onBotPress}
            accessibilityRole="button"
            accessibilityLabel={`${title}. Open Bot details.`}
            style={styles.titlePress}>
            <Text variant="headline" numberOfLines={1} style={styles.name}>
              {title}
            </Text>
          </PressableScale>
        ) : (
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
        )}
        <View style={styles.subtitleLine}>
          <PressableScale
            onPress={onModelPress}
            disabled={!showModel}
            hitSlop={8}
            accessibilityRole={showModel ? 'button' : undefined}
            accessibilityLabel={showModel ? `Model: ${modelLabel}. Change model.` : undefined}
            style={[styles.titlePress, styles.subtitleRow]}>
            <Text variant="caption" color="secondary" numberOfLines={1} style={styles.subtitle}>
              {subtitle}
            </Text>
            {showModel ? (
              <Icon
                name={{ ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }}
                size={12}
                color={tokens.textTertiary}
              />
            ) : null}
          </PressableScale>
          {spendNote ? (
            <>
              <View style={[styles.spendDot, { backgroundColor: tokens.textTertiary }]} />
              <Text variant="caption" color="tertiary" numberOfLines={1} style={styles.spend}>
                {spendNote}
              </Text>
            </>
          ) : null}
        </View>
      </View>
    </View>
  );

  const overflow = onOverflowPress ? (
    <PressableScale
      onPress={onOverflowPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel="Chat options"
      accessibilityState={{ expanded: overflowExpanded ?? false }}
      style={styles.control}>
      <Icon
        name={{ ios: 'ellipsis', android: 'more_horiz', web: 'more_horiz' }}
        size={20}
        color="textPrimary"
      />
    </PressableScale>
  ) : null;

  return (
    <View style={styles.bar}>
      {leading}
      {titles}
      {overflow}
    </View>
  );
}

export const ChatHeader = memo(ChatHeaderImpl);
ChatHeader.displayName = 'ChatHeader';

const styles = StyleSheet.create({
  // Flat on the stage: no card, no ring. The bar is told from the transcript
  // by the space above the first message, not by a surface of its own.
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    minHeight: 56,
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.one,
    paddingBottom: Spacing.one,
  },
  control: {
    width: 40,
    height: 40,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identity: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
    paddingLeft: Spacing.one,
  },
  titles: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  titlePress: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    justifyContent: 'center',
  },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  subtitle: {
    flexShrink: 1,
  },
  subtitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
    minWidth: 0,
  },
  spendDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
  },
  spend: {
    flexShrink: 0,
    fontVariant: ['tabular-nums'],
  },
  name: {
    fontSize: 17,
    lineHeight: 22,
  },
});
