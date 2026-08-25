import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BaseSheet, Button, ConfirmSheet, Divider, ListRow, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import type { PublicBot } from '@/lib/gateway/bots';
import { roomMemberNames, type BotGroupRoom } from '@/lib/gateway/groups';

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
};

/**
 * The roster group row's action surface: member line, then the room verbs —
 * open, rename, disband — without entering the room first. A port of the bot
 * detail-sheet pattern (bot-detail-sheet.tsx): the rows are decided by the
 * parent's capability gates, and every write keeps the Gate's answer as the
 * truth (rename shows the returned room; disband leaves only after the Gate
 * confirms). Members the loaded inventory has never seen are named by raw id
 * with a "not on this gateway" count — never an invented name.
 */
export function GroupRoomActionSheet({
  room,
  members = [],
  onClose,
  onOpen,
  onRename,
  onDisband,
}: GroupRoomActionSheetProps) {
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renamingBusy, setRenamingBusy] = useState(false);
  const [disbandVisible, setDisbandVisible] = useState(false);
  const [disbanding, setDisbanding] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (!room) return null;

  const busy = renamingBusy || disbanding;
  const close = () => {
    if (busy) return;
    onClose();
  };
  const memberFacts = roomMemberNames(
    room,
    new Map(members.map((bot) => [bot.id, bot.displayName])),
  );

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
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setRenamingBusy(false));
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
        setError(cause instanceof Error ? cause.message : String(cause));
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
        {renaming ? (
          <View style={styles.facts}>
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
                onPress={submitRename}
              />
            </View>
          </View>
        ) : (
          <View style={styles.facts}>
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
          </View>
        )}
      </BaseSheet>

      <ConfirmSheet
        visible={disbandVisible && !renaming}
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
  sheetError: { marginBottom: Spacing.two },
  sheetActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.two,
  },
  renameField: { minHeight: 0, marginBottom: Spacing.one },
});