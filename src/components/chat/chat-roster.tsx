import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BotAvatar } from '@/components/chat/bot-avatar';
import { EmptyState, ListRow, Skeleton, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import {
  botRowSubtitle,
  filterRosterRows,
  type PublicBot,
  type RosterRow,
} from '@/lib/gateway/bots';

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
  const [query, setQuery] = useState('');

  if (loading && rows.length <= 1) {
    return (
      <View style={styles.pad}>
        <Skeleton width="88%" height={56} />
        <Skeleton width="72%" height={56} style={styles.gap} />
        <Skeleton width="80%" height={56} style={styles.gap} />
      </View>
    );
  }

  const visibleRows = filterRosterRows(rows, query);
  const visibleBotCount = visibleRows.filter((row) => row.kind === 'bot').length;

  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      {rows.length > 1 ? (
        <TextField
          value={query}
          onChangeText={setQuery}
          placeholder="Search agents"
          returnKeyType="search"
          style={styles.search}
        />
      ) : null}
      {error ? (
        <Text variant="caption" color="secondary" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {visibleRows.map((row) => {
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
            subtitle={botRowSubtitle(row.bot)}
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
      {rows.length > 1 && visibleBotCount === 0 ? (
        <EmptyState
          icon={{ ios: 'magnifyingglass', android: 'search', web: 'search' }}
          title={`No agents match "${query.trim()}"`}
          description="Names, ids, and descriptions are searched."
          actionLabel="Clear search"
          onAction={() => setQuery('')}
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: Spacing.three, paddingTop: Spacing.two, paddingBottom: Spacing.five },
  search: { marginBottom: Spacing.two, minHeight: 0, paddingVertical: 10 },
  row: { marginBottom: Spacing.one },
  gap: { marginTop: Spacing.two },
  error: { marginBottom: Spacing.two },
});
