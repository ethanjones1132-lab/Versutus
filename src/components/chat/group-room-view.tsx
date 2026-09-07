import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BotAvatar } from '@/components/chat/bot-avatar';
import { MarkdownText } from '@/components/chat/markdown/markdown-text';
import { StreamingIndicator } from '@/components/chat/streaming-indicator';
import { ComposerKeyboardLift } from '@/components/layout/ComposerKeyboardLift';
import { BaseSheet, Button, Chip, ConfirmSheet, Icon, PressableScale, Skeleton, Text, TextField } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { botChipModelPin, botChipRoutingTag, type PublicBot } from '@/lib/gateway/bots';
import {
  addableMembers,
  canAddMember,
  canRemoveMember,
  describeAddableExhaustion,
  describeDisbandedRound,
  describeRoomError,
  describeRoundOutcome,
  describeRoomPlan,
  formatGroupMessageTime,
  GROUP_MEMBER_FLOOR_REASON,
  MAX_GROUP_MEMBERS,
  groupSpeakers,
  mergeTranscriptRows,
  rosterDeadMembers,
  type BotGroupRoom,
  type GroupReply,
  type GroupTranscriptEntry,
} from '@/lib/gateway/groups';
import { extractMentions, insertMention, mentionPicksAtCaret } from '@/lib/gateway/mentions';
import { chatTranscriptContentPaddingBottom } from '@/lib/motion/chat-transcript-insets';
import { CHIP_HIT_SLOP } from '@/lib/motion/chip-hit-slop';
import { groupMemberChipPinMaxWidth } from '@/lib/motion/group-member-chip-layout';

// Follow the tail while the operator stays near it; scrolling up pins the
// room so a round's replies stop yanking the view back to the bottom
// (mirrors the transcript guard at chat-screen.tsx:117).
const PIN_THRESHOLD_PX = 96;

/**
 * One exchange in the room: the operator's message (with how many replies it
 * drew — the visible round/message-cap feedback) followed by each bot's
 * attributed bubble in arrival order.
 */
type RoomEntry =
  | {
      id: string;
      role: 'user';
      text: string;
      replyCount?: number;
      at?: number;
      /** Send-time scope truth for the outcome line (see describeRoundOutcome). */
      speakerCount?: number;
      routableCount?: number;
      silentNames?: string[];
      /** Roster-confirmed unroutable names are in silentNames; these are the
       *  members this phone has never seen on the loaded inventory. */
      unknownNames?: string[];
      /** False when the roster inventory had not been read at send time —
       *  the outcome line must never claim a routing verdict it lacks. */
      rosterLoaded?: boolean;
      /** True when the Gate reported the room was disbanded while this
       *  round ran: replies happened but nothing was stored. Replaces the
       *  reply-count outcome line with the honest loss note. */
      roomDisbanded?: boolean;
    }
  | { id: string; role: 'bot'; botId: string; text: string; at?: number };

/**
 * Bubble meta lines. The user bubble keeps ONE micro line that grows with the
 * round's feedback (stamp · outcome); a bot bubble appends its stamp to the
 * author line. A missing/corrupt stamp simply renders nothing — never a
 * literal 'Invalid Date'. The outcome segment comes from the pure helper so
 * a round that died on routing never reads as bot choice.
 */
function userMetaLine(entry: Extract<RoomEntry, { role: 'user' }>): string {
  const parts: string[] = [];
  if (typeof entry.at === 'number') {
    const time = formatGroupMessageTime(entry.at);
    if (time) parts.push(time);
  }
  if (entry.roomDisbanded) {
    // The Gate deleted the room while the round ran: claims of "N replied
    // this round" would pretend the conversation is stored when it is gone.
    parts.push(describeDisbandedRound());
  } else if (typeof entry.replyCount === 'number') {
    parts.push(
      describeRoundOutcome({
        replyCount: entry.replyCount,
        // Missing scope fields (future writer drift) degrade to the legacy
        // all-routable reading instead of dropping or inventing a verdict.
        speakerCount: entry.speakerCount ?? 0,
        routableCount: entry.routableCount ?? 0,
        silentNames: entry.silentNames ?? [],
        unknownNames: entry.unknownNames ?? [],
        rosterLoaded: entry.rosterLoaded,
      }),
    );
  }
  return parts.join(' · ');
}

function botByline(name: string, at?: number): string {
  const time = typeof at === 'number' ? formatGroupMessageTime(at) : '';
  return time ? `${name} · ${time}` : name;
}

export function GroupRoomView({
  group,
  members,
  onSend,
  onRename,
  onLeave,
  onDisband,
  onAddMembers,
  loadHistory,
  inventoryLoaded = true,
}: {
  group: BotGroupRoom;
  members: PublicBot[];
  onSend: (text: string, mentionedIds: string[]) => Promise<{ replies: GroupReply[]; roomDisbanded?: boolean }>;
  onRename: (name: string) => Promise<BotGroupRoom>;
  onLeave: (memberId: string) => Promise<BotGroupRoom>;
  onDisband: () => Promise<unknown>;
  /**
   * Appends members to the room on the Gate; the parent refreshes the roster
   * copy so the member chips show the joined roster. Absent on gateways
   * without rooms — the room then offers no add picker, same honesty gate
   * as the roster detail sheet.
   */
  onAddMembers?: (memberIds: string[]) => Promise<BotGroupRoom>;
  loadHistory?: () => Promise<GroupTranscriptEntry[]>;
  /** False when the phone has never completed a bot-inventory read — no
   *  routing verdicts can be drawn, so plan/outcome lines say so. */
  inventoryLoaded?: boolean;
}) {
  const tokens = useTokens();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const memberPinMaxWidth = groupMemberChipPinMaxWidth(fontScale);
  const scrollRef = useRef<FlatList<RoomEntry>>(null);
  const pinnedRef = useRef(true);
  const [entries, setEntries] = useState<RoomEntry[]>([]);
  const [historyError, setHistoryError] = useState(false);
  // Whether the first transcript replay has landed (stored lines or refusal).
  // The room opens with entries=[] before the async replay, which is
  // indistinguishable from a genuinely empty room without this flag.
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [renameVisible, setRenameVisible] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [addVisible, setAddVisible] = useState(false);
  const [addSelection, setAddSelection] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [disbandVisible, setDisbandVisible] = useState(false);
  const [disbanding, setDisbanding] = useState(false);
  // The room plan names silent/unknown members plus the round count and
  // routinely exceeds one caption line at 360dp; default-collapsed keeps the
  // card compact, a tap (same idiom as the approval-prompt expand) reveals it.
  const [planExpanded, setPlanExpanded] = useState(false);

  const displayNameOf = useMemo(() => {
    const byId = new Map(members.map((bot) => [bot.id, bot.displayName]));
    return (id: string) => byId.get(id) ?? id;
  }, [members]);

  // Pinned default model per member ('' = unpinned / older Gate) for the
  // micro pin beside each member's name. Same roster copy the chips use.
  const pinnedModelOf = useMemo(() => {
    const byId = new Map(members.map((bot) => [bot.id, botChipModelPin(bot)]));
    return (id: string) => byId.get(id) ?? '';
  }, [members]);

  // Why a member cannot route ('' = routable / older Gate), read from the
  // loaded roster only: undefined = the member is NOT on the inventory, so
  // the phone has never verified its routing — never claim it routable, and
  // never blame it for staying silent.
  const routingTagOf = useMemo(() => {
    const byId = new Map(members.map((bot) => [bot.id, botChipRoutingTag(bot)]));
    return (id: string) => byId.get(id);
  }, [members]);

  // Live round feedback: what you are about to send scopes the plan. Mentions
  // shrink the speaking set; otherwise the whole room takes the round.
  const mentioned = extractMentions(draft, group.memberIds);
  const speakers = groupSpeakers(group.memberIds, mentioned);
  // Typing at the end of the draft: TextField has no selection hook, so the
  // caret is the end. The helper still takes a caret so mid-token picks work
  // once a field can report one.
  const mentionPicks = mentionPicksAtCaret(draft, draft.length, group.memberIds);
  const removable = canRemoveMember(group);
  // Dead-id eviction mirrors the Gate's leave exemption: a member the
  // verified roster cannot answer to stays removable at the two-member
  // floor; an unread roster claims nothing and pins everyone.
  const deadMemberIds = rosterDeadMembers(group, {
    rosterIds: new Set(members.map((bot) => bot.id)),
    loaded: inventoryLoaded,
  });
  const memberIsRemovable = (memberId: string) =>
    removable || deadMemberIds.includes(memberId);

  // The plan line tells the truth about silence: a member that cannot route
  // is not a speaker, and a member the phone has never seen on the loaded
  // roster counts neither as a speaker nor as a silent choice. Only
  // roster-confirmed routable members make the count — the same verdict the
  // chips below carry.
  const silentSpeakerNames: string[] = [];
  const unknownSpeakerNames: string[] = [];
  let routableSpeakerCount = 0;
  for (const id of speakers) {
    const tag = routingTagOf(id);
    if (tag === undefined) unknownSpeakerNames.push(displayNameOf(id));
    else if (tag) silentSpeakerNames.push(displayNameOf(id));
    else routableSpeakerCount += 1;
  }

  const scrollToBottom = () => {
    if (!pinnedRef.current) return;
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  };

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    pinnedRef.current = distanceFromBottom < PIN_THRESHOLD_PX;
  }, []);

  // Replay the Gate-stored transcript once per room visit, so a revisit
  // continues the conversation instead of starting blank. Stored lines are
  // merged by id and send-window BEFORE anything typed this session — a send
  // that lands while history is in flight is never clobbered or duplicated.
  const historyRequested = useRef(false);
  useEffect(() => {
    if (!loadHistory || historyRequested.current) return;
    historyRequested.current = true;
    let alive = true;
    loadHistory()
      .then((stored) => {
        if (!alive) return;
        setEntries((prev) => mergeTranscriptRows(prev, stored));
        setHistoryLoaded(true);
      })
      .catch(() => {
        // Fail honest: say earlier replies may be missing instead of showing
        // a silently truncated room.
        if (alive) setHistoryError(true);
        if (alive) setHistoryLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [loadHistory]);

  // Pull-to-refresh re-reads the same transcript in place (the roster pattern
  // from 3824b97): new stored lines are folded in oldest-first, and a failed
  // or empty read never wipes what is already on screen — this room's stored
  // lines are recent truth, but the transcript in front of the operator is
  // the conversation, not a cached inventory.
  const handleRefresh = useCallback(() => {
    if (!loadHistory || refreshing) return;
    setRefreshing(true);
    loadHistory()
      .then((stored) => {
        setHistoryError(false);
        setEntries((prev) => mergeTranscriptRows(prev, stored));
      })
      .catch(() => {
        // Fail honest: say the re-read missed lines instead of pretending
        // everything made it in.
        setHistoryError(true);
      })
      .finally(() => setRefreshing(false));
  }, [loadHistory, refreshing]);

  const handleSend = () => {
    const text = draft.trim();
    if (!text || sending) return;
    const sentAt = Date.now();
    const entryId = `u-${sentAt}`;
    const mentionedIds = extractMentions(text, group.memberIds);
    // The outcome line must reflect THIS message's scope, frozen at send
    // time — not whatever the draft holds by the time replies land. Same
    // routing truth the plan line and chips already show.
    const roundSpeakers = groupSpeakers(group.memberIds, mentionedIds);
    const roundSilentNames: string[] = [];
    const roundUnknownNames: string[] = [];
    let roundRoutableCount = 0;
    for (const id of roundSpeakers) {
      const tag = routingTagOf(id);
      if (tag === undefined) roundUnknownNames.push(displayNameOf(id));
      else if (tag) roundSilentNames.push(displayNameOf(id));
      else roundRoutableCount += 1;
    }
    setEntries((prev) => [
      ...prev,
      {
        id: entryId,
        role: 'user',
        text,
        at: sentAt,
        speakerCount: roundSpeakers.length,
        routableCount: roundRoutableCount,
        silentNames: roundSilentNames,
        unknownNames: roundUnknownNames,
        rosterLoaded: inventoryLoaded,
      },
    ]);
    setDraft('');
    setSending(true);
    setError(undefined);
    scrollToBottom();
    onSend(text, mentionedIds)
      .then(({ replies, roomDisbanded }) => {
        const repliedAt = Date.now();
        setEntries((prev) => {
          const next: RoomEntry[] = [];
          for (const entry of prev) {
            if (entry.id !== entryId) {
              next.push(entry);
              continue;
            }
            // The user bubble keeps its text but now carries the round's
            // visible feedback: how many asked bots answered, or — short of
            // the full scope — exactly how many of them stayed silent. A
            // room the Gate disbanded while the round ran replaces the
            // reply count with the honest loss note (nothing was stored).
            next.push({
              id: entryId,
              role: 'user',
              text,
              replyCount: replies.length,
              at: sentAt,
              speakerCount: roundSpeakers.length,
              routableCount: roundRoutableCount,
              silentNames: roundSilentNames,
              unknownNames: roundUnknownNames,
              rosterLoaded: inventoryLoaded,
              roomDisbanded,
            });
            replies.forEach((reply, index) => {
              next.push({
                id: `${entryId}-r${index}`,
                role: 'bot',
                botId: reply.botId,
                text: reply.text,
                at: repliedAt,
              });
            });
          }
          return next;
        });
        scrollToBottom();
      })
      .catch((cause: unknown) => {
        // Fail honest AND fail restorative: the draft comes back so nothing
        // typed into a busy room is lost, and the refusal speaks the same
        // desktop-parity verdict + fix every other failure surface shows
        // instead of raw wire text.
        setDraft(text);
        setEntries((prev) => prev.filter((entry) => entry.id !== entryId));
        setError(describeRoomError(cause));
      })
      .finally(() => setSending(false));
  };

  const submitRename = () => {
    const name = renameDraft.trim();
    if (!name || renaming) return;
    setRenaming(true);
    onRename(name)
      .then(() => {
        setRenameVisible(false);
        setRenameDraft('');
      })
      .catch((cause: unknown) => {
        setError(describeRoomError(cause));
      })
      .finally(() => setRenaming(false));
  };

  // Who the room can still take: the loaded inventory's routable bots that
  // are not already members — the same eligibility the roster detail
  // sheet's picker follows, so the cap and the addressability checks hold
  // in both doors.
  const addCandidates = addableMembers(group, members);

  const submitAdd = () => {
    if (addSelection.length === 0 || adding || !onAddMembers) return;
    setAdding(true);
    void Promise.resolve(onAddMembers(addSelection))
      .then(() => {
        // The parent refreshes the roster copy behind the room, so the
        // member chips above show the joined roster; leave the picker.
        setAddVisible(false);
        setAddSelection([]);
      })
      .catch((cause: unknown) => {
        // Fail honest: the membership is unchanged; keep the selection so a
        // transient failure can be retried without picking everyone again.
        setError(describeRoomError(cause));
      })
      .finally(() => setAdding(false));
  };

  const confirmDisband = () => {
    if (disbanding) return;
    setDisbanding(true);
    onDisband()
      .then(() => setDisbandVisible(false))
      .catch((cause: unknown) => {
        // Fail honest: the room is still here; say why (desktop-parity
        // verdict + fix for classifiable refusals) instead of pretending
        // it disbanded.
        setDisbandVisible(false);
        setError(describeRoomError(cause));
      })
      .finally(() => setDisbanding(false));
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
      <FlatList
        ref={scrollRef}
        data={entries}
        keyExtractor={(entry) => entry.id}
        style={styles.flex}
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: chatTranscriptContentPaddingBottom({ platform: Platform.OS, insetBottom: insets.bottom }) },
        ]}
        keyboardShouldPersistTaps="handled"
        onScroll={handleScroll}
        scrollEventThrottle={16}
        removeClippedSubviews
        initialNumToRender={12}
        maxToRenderPerBatch={16}
        windowSize={9}
        refreshControl={
          loadHistory ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={tokens.accentWarm}
              colors={[tokens.accentWarm]}
              progressBackgroundColor={tokens.backgroundElevated}
            />
          ) : undefined
        }
        ListHeaderComponent={
          <View style={styles.listHeader}>
          <View
            style={[styles.roomCard, { backgroundColor: tokens.backgroundRaised, borderColor: tokens.glassBorder }]}>
            <View style={styles.roomCardHead}>
              <PressableScale
                onPress={() => setPlanExpanded((prev) => !prev)}
                accessibilityRole="button"
                accessibilityLabel={planExpanded ? 'Collapse room plan' : 'Show full room plan'}
                accessibilityState={{ expanded: planExpanded }}
                style={styles.roomPlanTarget}>
                <Text variant="caption" color="secondary" numberOfLines={planExpanded ? undefined : 1}>
                  {describeRoomPlan({
                    speakerCount: speakers.length,
                    routableCount: routableSpeakerCount,
                    silentNames: silentSpeakerNames,
                    unknownNames: unknownSpeakerNames,
                    rosterLoaded: inventoryLoaded,
                  })}
                </Text>
              </PressableScale>
              <View style={styles.headActions}>
                <PressableScale
                  onPress={() => {
                    setRenameDraft(group.name);
                    setRenameVisible(true);
                  }}
                  hitSlop={CHIP_HIT_SLOP}
                  accessibilityRole="button"
                  accessibilityLabel="Rename room"
                  accessibilityState={{ expanded: renameVisible }}
                  style={styles.renamePill}>
                  <Icon name={{ ios: 'pencil', android: 'edit', web: 'edit' }} size={12} color="textSecondary" />
                  <Text variant="micro" color="secondary">Rename</Text>
                </PressableScale>
                {onAddMembers && canAddMember(group) ? (
                  <PressableScale
                    onPress={() => {
                      setError(undefined);
                      setAddSelection([]);
                      setAddVisible(true);
                    }}
                    hitSlop={CHIP_HIT_SLOP}
                    accessibilityRole="button"
                    accessibilityLabel="Add members"
                    accessibilityState={{ expanded: addVisible }}
                    style={styles.renamePill}>
                    <Icon name={{ ios: 'person.badge.plus', android: 'person-add', web: 'person-add' }} size={12} color="textSecondary" />
                    <Text variant="micro" color="secondary">Add</Text>
                  </PressableScale>
                ) : null}
                <PressableScale
                  onPress={() => setDisbandVisible(true)}
                  hitSlop={CHIP_HIT_SLOP}
                  accessibilityRole="button"
                  accessibilityLabel="Disband room"
                  accessibilityHint="Opens a confirmation, then removes this room from the roster and deletes its transcript. This cannot be undone."
                  style={styles.renamePill}>
                  <Icon name={{ ios: 'trash', android: 'delete', web: 'delete' }} size={12} color="textSecondary" />
                  <Text variant="micro" color="secondary">Disband</Text>
                </PressableScale>
              </View>
            </View>
            {mentioned.length > 0 ? (
              <Text variant="micro" color="accentWarm" style={styles.scopeNote}>
                @mentions scope the round to {mentioned.length === 1 ? 'one bot' : `${mentioned.length} bots`}.
              </Text>
            ) : null}
            <View style={styles.chipWrap}>
              {group.memberIds.map((memberId) => {
                // Routing state outranks the pin: an unroutable chip shows WHY
                // it will stay silent instead of what a silent bot is pinned to,
                // and a member this phone has never seen on the roster says so
                // instead of masquerading as a verified speaker.
                const routingTag = routingTagOf(memberId);
                const modelPin = routingTag ? '' : pinnedModelOf(memberId);
                const missingFromRoster = routingTag === undefined;
                const evictable = memberIsRemovable(memberId);
                return (
                  <PressableScale
                    key={memberId}
                    onPress={evictable ? () => setPendingRemoval(memberId) : undefined}
                    disabled={!evictable}
                    hitSlop={evictable ? CHIP_HIT_SLOP : undefined}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !evictable }}
                    accessibilityLabel={
                      evictable
                        ? deadMemberIds.includes(memberId)
                          ? `Remove ${displayNameOf(memberId)} — not on this gateway's roster`
                          : `Remove ${displayNameOf(memberId)} from the room`
                        : `${displayNameOf(memberId)}. ${GROUP_MEMBER_FLOOR_REASON}.`
                    }
                    style={[
                      styles.memberChip,
                      { backgroundColor: tokens.glassHighlight, borderColor: tokens.border },
                    ]}>
                    <BotAvatar botId={memberId} size={22} />
                    <Text variant="caption" color="primary" numberOfLines={1}>
                      {displayNameOf(memberId)}
                    </Text>
                    {routingTag ? (
                      <Text variant="micro" color="accentWarm" numberOfLines={1} style={[styles.memberChipPin, { maxWidth: memberPinMaxWidth }]}>
                        {routingTag}
                      </Text>
                    ) : missingFromRoster ? (
                      <Text variant="micro" color="accentWarm" numberOfLines={1} style={[styles.memberChipPin, { maxWidth: memberPinMaxWidth }]}>
                        Not on gateway
                      </Text>
                    ) : modelPin ? (
                      <Text variant="micro" color="tertiary" numberOfLines={1} style={[styles.memberChipPin, { maxWidth: memberPinMaxWidth }]}>
                        {modelPin}
                      </Text>
                    ) : null}
                    {removable ? (
                      <Icon name={{ ios: 'xmark', android: 'close', web: 'close' }} size={10} color="textTertiary" />
                    ) : null}
                  </PressableScale>
                );
              })}
            </View>
            {!removable ? (
              <Text variant="micro" color="tertiary">{GROUP_MEMBER_FLOOR_REASON} — members are pinned.</Text>
            ) : null}
          </View>
          {historyError ? (
            <Text variant="micro" color="tertiary" style={styles.emptyHint}>
              Could not load earlier replies from the Gate — this visit may be missing older lines.
            </Text>
          ) : null}
          {historyError && loadHistory ? (
            <Button label="Retry" variant="ghost" size="sm" onPress={handleRefresh} />
          ) : null}
          {loadHistory && !historyLoaded ? (
            <>
              <Skeleton width="90%" height={44} />
              <Skeleton width="76%" height={44} style={styles.gap} />
            </>
          ) : null}
          {entries.length === 0 && (!loadHistory || historyLoaded) ? (
            <Text variant="caption" color="tertiary" style={styles.emptyHint}>
              Say something to the room. Every reply lands here, attributed to its bot.
            </Text>
          ) : null}
          </View>
        }
        ListFooterComponent={
          sending ? (
            <View style={styles.botRow}>
              <View style={[styles.botBubble, { backgroundColor: tokens.backgroundElevated }]}>
                <Text variant="caption" color="secondary">Bots are answering…</Text>
                <StreamingIndicator />
              </View>
            </View>
          ) : null
        }
        renderItem={({ item }) =>
          item.role === 'user' ? (
            <View style={styles.userRow}>
              <View style={[styles.userBubble, { backgroundColor: tokens.accentMuted }]}>
                <Text variant="body" color="primary">{item.text}</Text>
                {typeof item.at === 'number' || typeof item.replyCount === 'number' ? (
                  <Text variant="micro" color="secondary" style={styles.metaLine}>
                    {userMetaLine(item)}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : (
            <View style={styles.botRow}>
              <BotAvatar botId={item.botId} size={26} />
              <View style={[styles.botBubble, { backgroundColor: tokens.backgroundElevated }]}>
                <Text variant="micro" color="tertiary">{botByline(displayNameOf(item.botId), item.at)}</Text>
                <MarkdownText text={item.text} />
              </View>
            </View>
          )
        }
      />


      {error ? (
        <Text variant="caption" color="accentWarm" style={styles.error}>{error}</Text>
      ) : null}

      <ComposerKeyboardLift>
      <View style={[styles.dock, { borderColor: tokens.border }]}>
        {mentionPicks.length > 0 ? (
          <View style={styles.mentionPicks}>
            <Text variant="micro" color="tertiary">Mention</Text>
            <View style={styles.chipWrap}>
              {mentionPicks.map((memberId) => (
                <PressableScale
                  key={memberId}
                  onPress={() => setDraft(insertMention(draft, draft.length, memberId))}
                  accessibilityRole="button"
                  accessibilityLabel={`Mention ${displayNameOf(memberId)}`}
                  style={[
                    styles.memberChip,
                    { backgroundColor: tokens.glassHighlight, borderColor: tokens.border },
                  ]}>
                  <BotAvatar botId={memberId} size={22} />
                  <Text variant="caption" color="primary" numberOfLines={1}>
                    {displayNameOf(memberId)}
                  </Text>
                </PressableScale>
              ))}
            </View>
          </View>
        ) : null}
        <View style={styles.dockRow}>
          <TextField
            value={draft}
            onChangeText={setDraft}
            placeholder={`Message ${group.name}…`}
            editable={!sending}
            multiline
            style={styles.dockInput}
          />
          <Button
            label={sending ? 'Round running…' : 'Send'}
            variant="primary"
            size="md"
            disabled={sending || !draft.trim()}
            busy={sending}
            onPress={handleSend}
          />
        </View>
      </View>
      </ComposerKeyboardLift>

      <ConfirmSheet
        visible={pendingRemoval !== null}
        title="Remove from room"
        message={
          pendingRemoval
            ? `${displayNameOf(pendingRemoval)} leaves this room. Its past replies stay in the transcript.`
            : ''
        }
        confirmLabel="Remove"
        onCancel={() => setPendingRemoval(null)}
        onConfirm={() => {
          const memberId = pendingRemoval;
          setPendingRemoval(null);
          if (!memberId) return;
          onLeave(memberId).catch((cause: unknown) => {
            setError(describeRoomError(cause));
          });
        }}
      />

      <ConfirmSheet
        visible={disbandVisible}
        title="Disband room"
        message={`${group.name} leaves the roster and its transcript is deleted from the Gate. This cannot be undone.`}
        confirmLabel={disbanding ? 'Disbanding…' : 'Disband'}
        busy={disbanding}
        onCancel={() => {
          if (disbanding) return;
          setDisbandVisible(false);
        }}
        onConfirm={confirmDisband}
      />

      <BaseSheet
        visible={renameVisible}
        eyebrow="GROUP ROOMS"
        onClose={() => {
          if (renaming) return;
          setRenameVisible(false);
          setRenameDraft('');
        }}
        closeLabel="Cancel"
        position="bottom">
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.sheetScroll}>
          <Text variant="title">Rename room</Text>
          <Text variant="caption" color="secondary" style={styles.hint}>
            The room keeps its members and history — only the name changes.
          </Text>
          <TextField
            value={renameDraft}
            onChangeText={setRenameDraft}
            placeholder="New room name"
            autoCapitalize="none"
            onSubmitEditing={submitRename}
            style={styles.renameField}
          />
          {error ? (
            <Text variant="caption" color="accentWarm" style={styles.sheetError}>{error}</Text>
          ) : null}
          <View style={styles.sheetActions}>
            <Button
              label="Cancel"
              variant="ghost"
              onPress={() => {
                setRenameVisible(false);
                setRenameDraft('');
              }}
              disabled={renaming}
            />
            <Button
              label={renaming ? 'Renaming…' : 'Rename'}
              variant="primary"
              disabled={renaming || !renameDraft.trim()}
              busy={renaming}
              onPress={submitRename}
            />
          </View>
        </ScrollView>
      </BaseSheet>

      <BaseSheet
        visible={addVisible}
        eyebrow="GROUP ROOMS"
        onClose={() => {
          if (adding) return;
          setAddVisible(false);
          setAddSelection([]);
        }}
        closeLabel="Cancel"
        position="bottom">
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.sheetScroll}>
          <Text variant="title">Add members</Text>
          <Text variant="caption" color="secondary" style={styles.hint}>
            New members join future sends — history stays as it was.
          </Text>
          <Text variant="caption" color="tertiary">
            {group.memberIds.length}/{MAX_GROUP_MEMBERS} members · {addSelection.length} selected
          </Text>
          {addCandidates.length > 0 ? (
            <View style={styles.chipWrap}>
              {addCandidates.map((bot) => (
                <Chip
                  key={bot.id}
                  label={displayNameOf(bot.id)}
                  selected={addSelection.includes(bot.id)}
                  onPress={() =>
                    setAddSelection((prev) =>
                      prev.includes(bot.id) ? prev.filter((id) => id !== bot.id) : [...prev, bot.id],
                    )
                  }
                />
              ))}
            </View>
          ) : (
            <Text variant="caption" color="secondary">
              {describeAddableExhaustion({ inventoryLoaded })}
            </Text>
          )}
          {error ? (
            <Text variant="caption" color="accentWarm" style={styles.sheetError}>{error}</Text>
          ) : null}
          <View style={styles.sheetActions}>
            <Button
              label="Cancel"
              variant="ghost"
              onPress={() => {
                setAddVisible(false);
                setAddSelection([]);
              }}
              disabled={adding}
            />
            <Button
              label={adding ? 'Adding…' : 'Add to room'}
              variant="primary"
              disabled={adding || addSelection.length === 0}
              busy={adding}
              onPress={submitAdd}
            />
          </View>
        </ScrollView>
      </BaseSheet>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { paddingHorizontal: Spacing.three, paddingTop: Spacing.two, paddingBottom: Spacing.two, gap: Spacing.two },
  roomCard: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.two,
    gap: Spacing.one + 2,
  },
  roomCardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  // The plan is a press target: fill the head's lead side so the whole line,
  // not just the glyphs, toggles expansion.
  roomPlanTarget: { flex: 1, minHeight: 36, justifyContent: 'center' },
  headActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  renamePill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: Spacing.two },
  scopeNote: {},
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one + 2 },
  memberChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one - 2,
    paddingLeft: 3,
    paddingRight: Spacing.one + 2,
    paddingVertical: 3,
    borderRadius: Radius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  // Bounded so a long model id can never stretch one chip past half the row
  // even at the six-member cap — the wrap stays two-plus chips per line.
  memberChipPin: { maxWidth: 120 },
  emptyHint: { textAlign: 'center', paddingVertical: Spacing.four },
  gap: { marginTop: Spacing.two },
  listHeader: { gap: Spacing.two },
  userRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  userBubble: {
    maxWidth: '82%',
    borderTopLeftRadius: Radius.md,
    borderBottomLeftRadius: Radius.md,
    borderTopRightRadius: Radius.full,
    borderBottomRightRadius: Radius.md,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one + 2,
    gap: 2,
  },
  metaLine: {},
  botRow: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.one },
  botBubble: {
    maxWidth: '82%',
    borderTopRightRadius: Radius.md,
    borderBottomRightRadius: Radius.md,
    borderTopLeftRadius: Radius.full,
    borderBottomLeftRadius: Radius.md,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one + 2,
    gap: 2,
  },
  error: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.one },
  hint: { marginBottom: Spacing.two },
  sheetError: { marginBottom: Spacing.two },
  sheetActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.two },
  sheetScroll: { paddingHorizontal: Spacing.two, paddingBottom: Spacing.two, gap: Spacing.one },
  renameField: { minHeight: 0, marginBottom: Spacing.one },
  dock: {
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  dockRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
  },
  mentionPicks: { gap: Spacing.one },
  dockInput: { flex: 1, minHeight: 48 },
});
