import { ScrollView, StyleSheet, View } from 'react-native';

import { BotAvatar } from '@/components/chat/bot-avatar';
import { EmptyState, ListRow, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import type { PublicBot, RosterRow } from '@/lib/gateway/bots';

export type ChatRosterProps = {
  rows: RosterRow[];
  loading?: boolean;
  error?: string;
  onSelectConfigurable: () => void;
  onSelectBot: (bot: PublicBot) => void;
  onNewAgent?: () => void;
};

export function ChatRoster({
  rows,
  loading = false,
  error,
  onSelectConfigurable,
  onSelectBot,
  onNewAgent,
}: ChatRosterProps) {
  if (loading && rows.length <= 1) {
    return (
      <View style={styles.pad}>
        <Skeleton width="88%" height={56} />
        <Skeleton width="72%" height={56} style={styles.gap} />
        <Skeleton width="80%" height={56} style={styles.gap} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.pad}>
      {error ? (
        <Text variant="caption" color="secondary" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {rows.map((row) => {
        if (row.kind === 'configurable') {
          return (
            <ListRow
              key="configurable"
              title="Chat"
              subtitle="Model, sessions, and backend"
              icon={{ ios: 'bubble.left.and.bubble.right', android: 'chat', web: 'chat' }}
              onPress={onSelectConfigurable}
              style={styles.row}
            />
          );
        }
        return (
          <ListRow
            key={row.bot.id}
            title={row.bot.displayName}
            subtitle={row.bot.routable ? 'Bot' : 'No listen key'}
            leading={<BotAvatar botId={row.bot.id} />}
            onPress={row.bot.routable ? () => onSelectBot(row.bot) : undefined}
            style={styles.row}
          />
        );
      })}
      {onNewAgent ? (
        <ListRow
          title="New Agent"
          subtitle="Name, soul, keys, and model pin"
          icon={{ ios: 'plus.circle', android: 'add_circle', web: 'add_circle' }}
          onPress={onNewAgent}
          style={styles.row}
        />
      ) : null}
      {rows.length === 1 ? (
        <EmptyState
          icon={{ ios: 'person.crop.circle', android: 'person', web: 'person' }}
          title="No bots on this gateway"
          description="Named Hermes profiles appear here once the Gate can inventory them."
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: Spacing.three, paddingTop: Spacing.two, paddingBottom: Spacing.five },
  row: { marginBottom: Spacing.one },
  gap: { marginTop: Spacing.two },
  error: { marginBottom: Spacing.two },
});
