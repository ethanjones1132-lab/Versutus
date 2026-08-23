import { useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { BotAvatar } from '@/components/chat/bot-avatar';
import { BaseSheet, Button, ConfirmSheet, Icon, PressableScale, Text, TextField } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { PublicBot } from '@/lib/gateway/bots';
import {
  canRemoveMember,
  describeGroupPlan,
  GROUP_MEMBER_FLOOR_REASON,
  groupSpeakers,
  MAX_GROUP_MESSAGES,
  type BotGroupRoom,
  type GroupReply,
} from '@/lib/gateway/groups';
import { extractMentions } from '@/lib/gateway/mentions';

/**
 * One exchange in the room: the operator's message (with how many replies it
 * drew — the visible round/message-cap feedback) followed by each bot's
 * attributed bubble in arrival order.
 */
type RoomEntry =
  | { id: string; role: 'user'; text: string; replyCount?: number; capped?: boolean }
  | { id: string; role: 'bot'; botId: string; text: string };

export function GroupRoomView({
  group,
  members,
  onSend,
  onRename,
  onLeave,
}: {
  group: BotGroupRoom;
  members: PublicBot[];
  onSend: (text: string, mentionedIds: string[]) => Promise<{ replies: GroupReply[] }>;
  onRename: (name: string) => Promise<BotGroupRoom>;
  onLeave: (memberId: string) => Promise<BotGroupRoom>;
}) {
  const tokens = useTokens();
  const scrollRef = useRef<ScrollView>(null);
  const [entries, setEntries] = useState<RoomEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [renameVisible, setRenameVisible] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);

  const displayNameOf = useMemo(() => {
    const byId = new Map(members.map((bot) => [bot.id, bot.displayName]));
    return (id: string) => byId.get(id) ?? id;
  }, [members]);

  // Live round feedback: what you are about to send scopes the plan. Mentions
  // shrink the speaking set; otherwise the whole room takes the round.
  const mentioned = extractMentions(draft, group.memberIds);
  const speakers = groupSpeakers(group.memberIds, mentioned);
  const removable = canRemoveMember(group);

  const scrollToBottom = () => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  };

  const handleSend = () => {
    const text = draft.trim();
    if (!text || sending) return;
    const entryId = `u-${Date.now()}`;
    const mentionedIds = extractMentions(text, group.memberIds);
    setEntries((prev) => [...prev, { id: entryId, role: 'user', text }]);
    setDraft('');
    setSending(true);
    setError(undefined);
    scrollToBottom();
    onSend(text, mentionedIds)
      .then(({ replies }) => {
        setEntries((prev) => {
          const next: RoomEntry[] = [];
          for (const entry of prev) {
            if (entry.id !== entryId) {
              next.push(entry);
              continue;
            }
            // The user bubble keeps its text but now carries the round's
            // visible feedback: how many bots answered and whether the cap
            // stopped the plan early.
            next.push({
              id: entryId,
              role: 'user',
              text,
              replyCount: replies.length,
              capped: replies.length >= MAX_GROUP_MESSAGES,
            });
            replies.forEach((reply, index) => {
              next.push({
                id: `${entryId}-r${index}`,
                role: 'bot',
                botId: reply.botId,
                text: reply.text,
              });
            });
          }
          return next;
        });
        scrollToBottom();
      })
      .catch((cause: unknown) => {
        // Fail honest AND fail restorative: the draft comes back so nothing
        // typed into a busy room is lost.
        setDraft(text);
        setEntries((prev) => prev.filter((entry) => entry.id !== entryId));
        setError(cause instanceof Error ? cause.message : String(cause));
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
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setRenaming(false));
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled">
        <View
          style={[styles.roomCard, { backgroundColor: tokens.backgroundRaised, borderColor: tokens.glassBorder }]}>
          <View style={styles.roomCardHead}>
            <Text variant="caption" color="secondary" numberOfLines={1}>
              {describeGroupPlan(speakers.length)}
            </Text>
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
          </View>
          {mentioned.length > 0 ? (
            <Text variant="micro" color="accentWarm" style={styles.scopeNote}>
              @mentions scope the round to {mentioned.length === 1 ? 'one bot' : `${mentioned.length} bots`}.
            </Text>
          ) : null}
          <View style={styles.chipWrap}>
            {group.memberIds.map((memberId) => (
              <PressableScale
                key={memberId}
                onPress={removable ? () => setPendingRemoval(memberId) : undefined}
                disabled={!removable}
                accessibilityRole="button"
                accessibilityLabel={
                  removable
                    ? `Remove ${displayNameOf(memberId)} from the room`
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
                {removable ? (
                  <Icon name={{ ios: 'xmark', android: 'close', web: 'close' }} size={10} color="textTertiary" />
                ) : null}
              </PressableScale>
            ))}
          </View>
          {!removable ? (
            <Text variant="micro" color="tertiary">{GROUP_MEMBER_FLOOR_REASON} — members are pinned.</Text>
          ) : null}
        </View>

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
                {typeof entry.replyCount === 'number' ? (
                  <Text variant="micro" color="secondary" style={styles.metaLine}>
                    {entry.replyCount === 0
                      ? 'No replies — every bot stayed silent.'
                      : `${entry.replyCount} repl${entry.replyCount === 1 ? 'y' : 'ies'} this round`}
                    {entry.capped ? ' · stopped at the message cap' : ''}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : (
            <View key={entry.id} style={styles.botRow}>
              <BotAvatar botId={entry.botId} size={26} />
              <View style={[styles.botBubble, { backgroundColor: tokens.backgroundElevated }]}>
                <Text variant="micro" color="tertiary">{displayNameOf(entry.botId)}</Text>
                <Text variant="body" color="primary">{entry.text}</Text>
              </View>
            </View>
          ),
        )}
      </ScrollView>

      {error ? (
        <Text variant="caption" color="accentWarm" style={styles.error}>{error}</Text>
      ) : null}

      <View style={[styles.dock, { borderColor: tokens.border }]}>
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
            setError(cause instanceof Error ? cause.message : String(cause));
          });
        }}
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
  renameField: { minHeight: 0, marginBottom: Spacing.one },
  dock: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  dockInput: { flex: 1, minHeight: 0 },
});
