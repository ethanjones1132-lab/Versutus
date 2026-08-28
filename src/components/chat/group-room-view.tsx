import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BotAvatar } from '@/components/chat/bot-avatar';
import { ComposerKeyboardLift } from '@/components/layout/ComposerKeyboardLift';
import { BaseSheet, Button, ConfirmSheet, Icon, PressableScale, Text, TextField } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { botChipModelPin, botChipRoutingTag, type PublicBot } from '@/lib/gateway/bots';
import {
  canRemoveMember,
  describeDisbandedRound,
  describeRoomError,
  describeRoundOutcome,
  describeRoomPlan,
  formatGroupMessageTime,
  GROUP_MEMBER_FLOOR_REASON,
  groupSpeakers,
  mergeTranscriptRows,
  rosterDeadMembers,
  type BotGroupRoom,
  type GroupReply,
  type GroupTranscriptEntry,
} from '@/lib/gateway/groups';
import { extractMentions, insertMention, mentionPicksAtCaret } from '@/lib/gateway/mentions';
import { chatTranscriptContentPaddingBottom } from '@/lib/motion/chat-transcript-insets';

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
  loadHistory,
  inventoryLoaded = true,
}: {
  group: BotGroupRoom;
  members: PublicBot[];
  onSend: (text: string, mentionedIds: string[]) => Promise<{ replies: GroupReply[]; roomDisbanded?: boolean }>;
  onRename: (name: string) => Promise<BotGroupRoom>;
  onLeave: (memberId: string) => Promise<BotGroupRoom>;
  onDisband: () => Promise<unknown>;
  loadHistory?: () => Promise<GroupTranscriptEntry[]>;
  /** False when the phone has never completed a bot-inventory read — no
   *  routing verdicts can be drawn, so plan/outcome lines say so. */
  inventoryLoaded?: boolean;
}) {
  const tokens = useTokens();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const [entries, setEntries] = useState<RoomEntry[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [renameVisible, setRenameVisible] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [disbandVisible, setDisbandVisible] = useState(false);
  const [disbanding, setDisbanding] = useState(false);

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
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  };

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
      })
      .catch(() => {
        // Fail honest: say earlier replies may be missing instead of showing
        // a silently truncated room.
        if (alive) setHistoryError(true);
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
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: chatTranscriptContentPaddingBottom({ platform: Platform.OS, insetBottom: insets.bottom }) },
        ]}
        keyboardShouldPersistTaps="handled"
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
        }>
        <View
          style={[styles.roomCard, { backgroundColor: tokens.backgroundRaised, borderColor: tokens.glassBorder }]}>
          <View style={styles.roomCardHead}>
            <Text variant="caption" color="secondary" numberOfLines={1}>
              {describeRoomPlan({
                speakerCount: speakers.length,
                routableCount: routableSpeakerCount,
                silentNames: silentSpeakerNames,
                unknownNames: unknownSpeakerNames,
                rosterLoaded: inventoryLoaded,
              })}
            </Text>
            <View style={styles.headActions}>
              <PressableScale
                onPress={() => {
                  setRenameDraft(group.name);
                  setRenameVisible(true);
                }}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel="Rename room"
                style={styles.renamePill}>
                <Icon name={{ ios: 'pencil', android: 'edit', web: 'edit' }} size={12} color="textSecondary" />
                <Text variant="micro" color="secondary">Rename</Text>
              </PressableScale>
              <PressableScale
                onPress={() => setDisbandVisible(true)}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel="Disband room"
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
                  accessibilityRole="button"
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
                    <Text variant="micro" color="accentWarm" numberOfLines={1} style={styles.memberChipPin}>
                      {routingTag}
                    </Text>
                  ) : missingFromRoster ? (
                    <Text variant="micro" color="accentWarm" numberOfLines={1} style={styles.memberChipPin}>
                      Not on gateway
                    </Text>
                  ) : modelPin ? (
                    <Text variant="micro" color="tertiary" numberOfLines={1} style={styles.memberChipPin}>
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

        {entries.length === 0 ? (
          <Text variant="caption" color="tertiary" style={styles.emptyHint}>
            Say something to the room. Every reply lands here, attributed to its bot.
          </Text>
        ) : null}

        {entries.map((entry) =>
          entry.role === 'user' ? (
            <View key={entry.id} style={styles.userRow}>
              <View style={[styles.userBubble, { backgroundColor: tokens.accentMuted }]}>
                <Text variant="body" color="primary">{entry.text}</Text>
                {typeof entry.at === 'number' || typeof entry.replyCount === 'number' ? (
                  <Text variant="micro" color="secondary" style={styles.metaLine}>
                    {userMetaLine(entry)}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : (
            <View key={entry.id} style={styles.botRow}>
              <BotAvatar botId={entry.botId} size={26} />
              <View style={[styles.botBubble, { backgroundColor: tokens.backgroundElevated }]}>
                <Text variant="micro" color="tertiary">{botByline(displayNameOf(entry.botId), entry.at)}</Text>
                <Text variant="body" color="primary">{entry.text}</Text>
              </View>
            </View>
          ),
        )}
      </ScrollView>

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
            size="sm"
            disabled={sending || !draft.trim()}
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
              onPress={submitRename}
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
  headActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  renamePill: { flexDirection: 'row', alignItems: 'center', gap: 4 },
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
  dockInput: { flex: 1, minHeight: 0 },
});
