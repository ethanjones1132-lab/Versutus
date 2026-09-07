import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BaseSheet, Button, Chip, ConfirmSheet, Divider, ListRow, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import type { PublicBot } from '@/lib/gateway/bots';
import {
  GROUP_MEMBER_FLOOR_REASON,
  MAX_GROUP_MEMBERS,
  addableMembers,
  canAddMember,
  canRemoveMember,
  describeAddableExhaustion,
  describeRoomError,
  removableMembers,
  roomMemberNames,
  type BotGroupRoom,
} from '@/lib/gateway/groups';

export type GroupRoomActionSheetProps = {
  /** The room acted on; null renders nothing (sheet dismissed). */
  room: BotGroupRoom | null;
  /** The loaded bot inventory — the roster copy is the only name source. */
  members?: PublicBot[];
  onClose: () => void;
  /**
   * Opens this room's chat — the parent owns that navigation (same path a
   * roster tap takes).
   */
  onOpen?: () => void;
  /**
   * Renames the room on the Gate; the parent refreshes the roster copy and
   * feeds the returned room back so the sheet shows the new name.
   */
  onRename?: (name: string) => Promise<BotGroupRoom>;
  /** Disbands the room on the Gate; the parent refreshes the roster copy. */
  onDisband?: () => Promise<unknown>;
  /**
   * Appends members to the room on the Gate; the parent feeds the Gate's
   * returned room back so the member line reflects the new membership.
   */
  onAddMembers?: (memberIds: string[]) => Promise<BotGroupRoom>;
  /**
   * Removes one member from the room on the Gate; the parent feeds the
   * Gate's returned room back so the member line reflects the shrunken
   * roster.
   */
  onRemoveMember?: (memberId: string) => Promise<BotGroupRoom>;
  /** False when the phone has never completed a bot-inventory read — an
   *  empty candidate list then means "nothing counted", not "all added". */
  inventoryLoaded?: boolean;
};

/**
 * The roster group row's action surface: member line, then the room verbs —
 * open, rename, add members, remove member, disband — without entering the
 * room first. A port of the bot detail-sheet pattern (bot-detail-sheet.tsx):
 * the rows are decided by the parent's capability gates, and every write
 * keeps the Gate's answer as the truth (rename/add/remove show the returned
 * room; disband leaves only after the Gate confirms). Members the loaded
 * inventory has never seen are named by raw id with a "not on this gateway"
 * count — never an invented name.
 */
export function GroupRoomActionSheet({
  room,
  members = [],
  inventoryLoaded = true,
  onClose,
  onOpen,
  onRename,
  onDisband,
  onAddMembers,
  onRemoveMember,
}: GroupRoomActionSheetProps) {
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renamingBusy, setRenamingBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addSelection, setAddSelection] = useState<string[]>([]);
  const [addingBusy, setAddingBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeSelection, setRemoveSelection] = useState<string | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);
  const [disbandVisible, setDisbandVisible] = useState(false);
  const [disbanding, setDisbanding] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (!room) return null;

  const busy = renamingBusy || addingBusy || removingBusy || disbanding;
  const close = () => {
    if (busy) return;
    onClose();
  };
  const namesById = new Map(members.map((bot) => [bot.id, bot.displayName]));
  const rosterIds = new Set(members.map((bot) => bot.id));
  const memberFacts = roomMemberNames(room, namesById);
  const candidates = addableMembers(room, members);
  // The verified roster decides who is evictable at the floor: a member no
  // loaded bot answers to can be removed even in a two-member room (the
  // Gate exempts it from its leave floor); an unread roster offers nothing.
  const removeOptions = removableMembers(room, namesById, { rosterIds, loaded: inventoryLoaded });

  const openRename = () => {
    setError(undefined);
    setRenameDraft(room.name);
    setRenaming(true);
  };

  const submitRename = () => {
    const name = renameDraft.trim();
    if (!name || renamingBusy || !onRename) return;
    setRenamingBusy(true);
    void Promise.resolve(onRename(name))
      .then((updated) => {
        setRenaming(false);
        setRenameDraft(updated?.name ?? name);
      })
      .catch((cause: unknown) => {
        // Fail honest: the room keeps its old name; say why instead of
        // pretending the rename landed.
        setError(describeRoomError(cause));
      })
      .finally(() => setRenamingBusy(false));
  };

  const openAdd = () => {
    setError(undefined);
    setAddSelection([]);
    setAdding(true);
  };

  const toggleCandidate = (botId: string) => {
    setAddSelection((prev) =>
      prev.includes(botId) ? prev.filter((id) => id !== botId) : [...prev, botId],
    );
  };

  const submitAdd = () => {
    if (addSelection.length === 0 || addingBusy || !onAddMembers) return;
    setAddingBusy(true);
    void Promise.resolve(onAddMembers(addSelection))
      .then(() => {
        // The parent fed the Gate's returned room back through props, so the
        // member line above now shows the joined roster; leave the picker.
        setAdding(false);
        setAddSelection([]);
      })
      .catch((cause: unknown) => {
        // Fail honest: the membership is unchanged; keep the selection so a
        // transient failure can be retried without picking everyone again.
        setError(describeRoomError(cause));
      })
      .finally(() => setAddingBusy(false));
  };

  const openRemove = () => {
    setError(undefined);
    setRemoveSelection(null);
    setRemoving(true);
  };

  const submitRemove = () => {
    if (!removeSelection || removingBusy || !onRemoveMember) return;
    setRemovingBusy(true);
    void Promise.resolve(onRemoveMember(removeSelection))
      .then(() => {
        // The parent fed the Gate's returned room back through props, so the
        // member line above now shows the shrunken roster; leave the picker.
        setRemoving(false);
        setRemoveSelection(null);
      })
      .catch((cause: unknown) => {
        // Fail honest: the membership is unchanged; keep the selection so a
        // transient failure can be retried without picking again.
        setError(describeRoomError(cause));
      })
      .finally(() => setRemovingBusy(false));
  };

  const confirmDisband = () => {
    if (disbanding) return;
    setDisbanding(true);
    void Promise.resolve(onDisband?.())
      .then(() => onClose())
      .catch((cause: unknown) => {
        // Fail honest: the room is still here; leave the confirm so the
        // operator reads why instead of thinking it disbanded.
        setDisbandVisible(false);
        setError(describeRoomError(cause));
      })
      .finally(() => setDisbanding(false));
  };

  return (
    <>
      <BaseSheet
        visible
        eyebrow="GROUP ROOM"
        title={room.name}
        onClose={close}
        closeLabel="Dismiss">
        {removing ? (
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.facts}>
            <Text variant="caption" color="secondary" style={styles.hint}>
              Removed members stop speaking in future sends — history stays as it was.
            </Text>
            <Text variant="caption" color="tertiary">
              {room.memberIds.length} members · {removeSelection ? 1 : 0} selected
            </Text>
            {removeOptions.length > 0 ? (
              <View style={styles.chipWrap}>
                {removeOptions.map((option) => (
                  <Chip
                    key={option.id}
                    label={option.label}
                    selected={removeSelection === option.id}
                    onPress={() =>
                      setRemoveSelection((prev) => (prev === option.id ? null : option.id))
                    }
                  />
                ))}
              </View>
            ) : (
              <Text variant="caption" color="secondary">
                {GROUP_MEMBER_FLOOR_REASON} — members are pinned.
              </Text>
            )}
            {error ? (
              <Text variant="caption" color="accentWarm" style={styles.sheetError}>
                {error}
              </Text>
            ) : null}
            <View style={styles.sheetActions}>
              <Button
                label="Cancel"
                variant="ghost"
                onPress={() => setRemoving(false)}
                disabled={removingBusy}
              />
              <Button
                label={removingBusy ? 'Removing…' : 'Remove from room'}
                variant="primary"
                disabled={removingBusy || !removeSelection}
                busy={removingBusy}
                onPress={submitRemove}
              />
            </View>
          </ScrollView>
        ) : adding ? (
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.facts}>
            <Text variant="caption" color="secondary" style={styles.hint}>
              New members join future sends — history stays as it was.
            </Text>
            <Text variant="caption" color="tertiary">
              {room.memberIds.length}/{MAX_GROUP_MEMBERS} members · {addSelection.length} selected
            </Text>
            {candidates.length > 0 ? (
              <View style={styles.chipWrap}>
                {candidates.map((bot) => (
                  <Chip
                    key={bot.id}
                    label={bot.displayName}
                    selected={addSelection.includes(bot.id)}
                    onPress={() => toggleCandidate(bot.id)}
                  />
                ))}
              </View>
            ) : (
              <Text variant="caption" color="secondary">
                {describeAddableExhaustion({ inventoryLoaded })}
              </Text>
            )}
            {error ? (
              <Text variant="caption" color="accentWarm" style={styles.sheetError}>
                {error}
              </Text>
            ) : null}
            <View style={styles.sheetActions}>
              <Button
                label="Cancel"
                variant="ghost"
                onPress={() => setAdding(false)}
                disabled={addingBusy}
              />
              <Button
                label={addingBusy ? 'Adding…' : 'Add to room'}
                variant="primary"
                disabled={addingBusy || addSelection.length === 0}
                busy={addingBusy}
                onPress={submitAdd}
              />
            </View>
          </ScrollView>
        ) : renaming ? (
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.facts}>
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
              <Text variant="caption" color="accentWarm" style={styles.sheetError}>
                {error}
              </Text>
            ) : null}
            <View style={styles.sheetActions}>
              <Button
                label="Cancel"
                variant="ghost"
                onPress={() => setRenaming(false)}
                disabled={renamingBusy}
              />
              <Button
                label={renamingBusy ? 'Renaming…' : 'Rename'}
                variant="primary"
                disabled={renamingBusy || !renameDraft.trim()}
                busy={renamingBusy}
                onPress={submitRename}
              />
            </View>
          </ScrollView>
        ) : (
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.facts}>
            <View style={styles.fact}>
              <Text variant="micro" color="tertiary">
                MEMBERS
              </Text>
              <Text variant="body">{memberFacts.names.join(', ')}</Text>
              {memberFacts.unknown > 0 ? (
                <Text variant="caption" color="accentWarm">
                  {memberFacts.unknown} not on this gateway
                </Text>
              ) : null}
            </View>

            <Divider />

            {onOpen ? (
              <ListRow
                title="Open room"
                subtitle="Members reply in rounds to one message"
                icon={{ ios: 'bubble.left.and.bubble.right', android: 'chat', web: 'chat' }}
                chevron={false}
                onPress={onOpen}
              />
            ) : null}
            {onRename ? (
              <ListRow
                title="Rename room"
                subtitle="Keep members and history"
                icon={{ ios: 'pencil', android: 'edit', web: 'edit' }}
                chevron={false}
                onPress={openRename}
              />
            ) : null}
            {onAddMembers && canAddMember(room) ? (
              <ListRow
                title="Add members"
                subtitle={
                  candidates.length > 0
                    ? 'Routable bots not already in this room'
                    : describeAddableExhaustion({ inventoryLoaded })
                }
                icon={{ ios: 'person.badge.plus', android: 'person-add', web: 'person-add' }}
                chevron={false}
                onPress={openAdd}
              />
            ) : null}
            {onRemoveMember && (canRemoveMember(room) || removeOptions.length > 0) ? (
              <ListRow
                title="Remove member"
                subtitle={
                  canRemoveMember(room)
                    ? 'Current members leave without deleting history'
                    : "Not on this gateway's roster — evict it without deleting history"
                }
                icon={{ ios: 'person.badge.minus', android: 'person_remove', web: 'person-remove' }}
                chevron={false}
                onPress={openRemove}
              />
            ) : null}
            {onDisband ? (
              <ListRow
                title="Disband room"
                subtitle="Delete the room and its transcript"
                icon={{ ios: 'trash', android: 'delete', web: 'delete' }}
                chevron={false}
                onPress={() => {
                  setError(undefined);
                  setDisbandVisible(true);
                }}
              />
            ) : null}
            {error ? (
              <Text variant="caption" color="accentWarm" style={styles.sheetError}>
                {error}
              </Text>
            ) : null}
          </ScrollView>
        )}
      </BaseSheet>

      <ConfirmSheet
        visible={disbandVisible && !renaming && !adding && !removing}
        title="Disband room"
        message={`${room.name} leaves the roster and its transcript is deleted from the Gate. This cannot be undone.`}
        confirmLabel={disbanding ? 'Disbanding…' : 'Disband'}
        onCancel={() => {
          if (disbanding) return;
          setDisbandVisible(false);
        }}
        onConfirm={confirmDisband}
      />
    </>
  );
}

const styles = StyleSheet.create({
  facts: {
    gap: Spacing.two,
    paddingHorizontal: Spacing.one,
  },
  fact: {
    gap: 2,
  },
  hint: { marginBottom: Spacing.two },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one + 2 },
  sheetError: { marginBottom: Spacing.two },
  sheetActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.two,
  },
  renameField: { minHeight: 0, marginBottom: Spacing.one },
});
