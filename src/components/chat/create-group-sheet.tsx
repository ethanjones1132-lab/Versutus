import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BaseSheet, Button, Chip, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import type { PublicBot } from '@/lib/gateway/bots';
import {
  MAX_GROUP_MEMBERS,
  MIN_GROUP_MEMBERS,
  validateGroup,
} from '@/lib/gateway/groups';

/**
 * Create a Gate-owned group room: a name plus 2–6 bots. Membership is chosen
 * from the roster's routable bots — a room naming an unroutable bot would
 * plan rounds the Gate refuses at send time.
 */
export function CreateGroupSheet({
  visible,
  busy = false,
  error,
  bots,
  onClose,
  onCreate,
}: {
  visible: boolean;
  busy?: boolean;
  error?: string;
  bots: PublicBot[];
  onClose: () => void;
  onCreate: (input: { name: string; memberIds: string[] }) => void;
}) {
  const [name, setName] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);

  const routable = bots.filter((bot) => bot.routable);
  const validation = validateGroup({ name, memberIds });

  const toggle = (botId: string) => {
    setMemberIds((prev) =>
      prev.includes(botId)
        ? prev.filter((id) => id !== botId)
        : prev.length >= MAX_GROUP_MEMBERS
          ? prev
          : [...prev, botId],
    );
  };

  return (
    <BaseSheet
      visible={visible}
      eyebrow="GROUP ROOMS"
      onClose={onClose}
      closeLabel="Cancel"
      position="bottom">
      <Text variant="title">New group room</Text>
      <Text variant="caption" color="secondary" style={styles.hint}>
        One message runs a round-robin: every member replies in turn, up to 3 rounds.
      </Text>

      <TextField
        value={name}
        onChangeText={setName}
        placeholder="Room name"
        autoCapitalize="none"
        style={styles.field}
      />

      <Text variant="caption" color="tertiary" style={styles.sectionLabel}>
        Members · {memberIds.length}/{MAX_GROUP_MEMBERS} selected (min {MIN_GROUP_MEMBERS})
      </Text>
      {routable.length >= MIN_GROUP_MEMBERS ? (
        <View style={styles.chipWrap}>
          {routable.map((bot) => (
            <Chip
              key={bot.id}
              label={bot.displayName}
              selected={memberIds.includes(bot.id)}
              onPress={() => toggle(bot.id)}
            />
          ))}
        </View>
      ) : (
        <Text variant="caption" color="secondary" style={styles.hint}>
          At least two routable bots are needed before a room can be created.
        </Text>
      )}

      {error ? (
        <Text variant="caption" color="accentWarm" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Button label="Cancel" variant="ghost" onPress={onClose} disabled={busy} />
        <Button
          label={busy ? 'Creating…' : 'Create room'}
          variant="primary"
          disabled={busy || !validation.ok}
          onPress={() => onCreate({ name: name.trim(), memberIds })}
        />
      </View>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  hint: { marginTop: Spacing.one, marginBottom: Spacing.two },
  field: { minHeight: 0 },
  sectionLabel: { marginBottom: Spacing.one },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one + 2, marginBottom: Spacing.two },
  error: { marginBottom: Spacing.two },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.two, marginTop: Spacing.one },
});
