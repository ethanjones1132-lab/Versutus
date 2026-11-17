import { memo, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { BotAvatar, GroupAvatar } from '@/components/chat/bot-avatar';
import { Icon, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { chatHeaderSubtitle, chatHeaderTitle } from '@/lib/motion/chat-header-layout';
import { handsfreeCallClock } from '@/lib/voice/handsfree-call-copy';

const subscribeCallClock = (onStoreChange: () => void) => {
  const timer = setInterval(onStoreChange, 1000);
  return () => clearInterval(timer);
};

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
  /**
   * True once the transcript has scrolled under the bar. Flat at its rest edge,
   * a quiet glass surface while content passes beneath it — the bar tells you
   * it is covering something instead of letting text collide with the title.
   */
  scrolled?: boolean;
  /** Starts a call, returns to the active call, or scrolls its banner into view. */
  onCallPress?: () => void;
  callMode?: 'start' | 'live-here' | 'live-elsewhere';
  callLabel?: string;
  callStartedAtMs?: number;
  /** A disabled call remains visible and explains itself to assistive tech. */
  callDisabledReason?: string;
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
  scrolled = false,
  onCallPress,
  callMode = 'start',
  callLabel,
  callStartedAtMs,
  callDisabledReason,
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
  const subscribeElapsed = useCallback(
    (onStoreChange: () => void) =>
      callStartedAtMs === undefined ? () => undefined : subscribeCallClock(onStoreChange),
    [callStartedAtMs],
  );
  const elapsedSeconds = useSyncExternalStore(
    subscribeElapsed,
    () => Math.floor(Date.now() / 1000),
    () => 0,
  );
  const elapsed = handsfreeCallClock(callStartedAtMs, elapsedSeconds * 1000);
  const pulseOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (callMode !== 'live-here') {
      pulseOpacity.setValue(1);
      return undefined;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseOpacity, { toValue: 0.25, duration: 550, useNativeDriver: true }),
        Animated.timing(pulseOpacity, { toValue: 1, duration: 550, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [callMode, pulseOpacity]);

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

  const callControl = onCallPress ? (
    <PressableScale
      onPress={onCallPress}
      disabled={callMode === 'start' && Boolean(callDisabledReason)}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={
        callMode === 'live-elsewhere'
          ? `Return to the call with ${callLabel ?? 'Bot'}`
          : callMode === 'start'
            ? 'Start hands-free call'
            : `Hands-free call with ${callLabel ?? 'Bot'}, ${elapsed ?? 'live'}. Show call banner.`
      }
      accessibilityHint={callDisabledReason}
      accessibilityState={{ disabled: callMode === 'start' && Boolean(callDisabledReason) }}
      style={[styles.control, styles.callHitTarget, styles.callControl, callMode !== 'start' && styles.liveCallControl]}>
      {callMode === 'start' ? (
        <Icon name={{ ios: 'phone', android: 'call', web: 'call' }} size={19} color={callDisabledReason ? 'textTertiary' : 'textPrimary'} />
      ) : callMode === 'live-here' ? (
        <Animated.View style={[styles.liveDot, { backgroundColor: tokens.statusConnected, opacity: pulseOpacity }]} />
      ) : (
        <Icon name={{ ios: 'phone.fill', android: 'call', web: 'call' }} size={16} color="accent" />
      )}
      {callMode !== 'start' ? (
        <Text variant="caption" color={callMode === 'live-elsewhere' ? 'accent' : 'primary'} numberOfLines={1} style={styles.callText}>
          {callMode === 'live-elsewhere'
            ? `On a call with ${callLabel ?? 'Bot'}`
            : elapsed ?? 'On a call'}
        </Text>
      ) : null}
    </PressableScale>
  ) : null;

  return (
    <View
      testID="chat-header"
      style={[
        styles.bar,
        scrolled && { backgroundColor: tokens.stageGlass, borderBottomColor: tokens.border },
      ]}>
      {leading}
      {titles}
      {callControl}
      {overflow}
    </View>
  );
}

export const ChatHeader = memo(ChatHeaderImpl);
ChatHeader.displayName = 'ChatHeader';

const styles = StyleSheet.create({
  // Flat on the stage: no card, no ring. The bar is told from the transcript
  // by the space above the first message, not by a surface of its own. The
  // hairline is always there (transparent at rest) so gaining the scroll
  // surface never nudges the row by half a pixel.
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    minHeight: 56,
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.one,
    paddingBottom: Spacing.one,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'transparent',
  },
  control: {
    width: 40,
    height: 40,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callHitTarget: {
    minWidth: 44,
    minHeight: 44,
  },
  callControl: {
    flexDirection: 'row',
    gap: Spacing.one,
    paddingHorizontal: Spacing.one,
  },
  // The live control is not an icon circle: it carries a clock ("0:12",
  // "1:04:12") or "On a call with <Bot>". It therefore owns its width —
  // natural, but never below the room a mm:ss caption needs beside the dot
  // (8 dot + 4 gap + ~48 clock + 8 padding) and never shrinking, so the
  // clock is not cut to "0:…" the way the shared 40 pt circle cut it. The
  // title block yields first instead (see `identity`/`titles` below).
  liveCallControl: {
    width: 'auto',
    minWidth: 72,
    flexShrink: 0,
    maxWidth: 156,
  },
  callText: {
    flexShrink: 1,
    fontVariant: ['tabular-nums'],
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
  },
  identity: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two + 2,
    paddingLeft: Spacing.one,
  },
  titles: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    gap: 1,
  },
  titlePress: {
    alignSelf: 'flex-start',
    flexShrink: 1,
    maxWidth: '100%',
    justifyContent: 'center',
  },
  subtitleRow: {
    flex: 1,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
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
    minWidth: 0,
    flexShrink: 1,
    fontVariant: ['tabular-nums'],
  },
  name: {
    fontSize: 17,
    lineHeight: 22,
  },
});
