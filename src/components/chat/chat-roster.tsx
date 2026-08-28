import { useState } from 'react';
import { Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BotAvatar } from '@/components/chat/bot-avatar';
import { EmptyState, ListRow, Skeleton, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import {
  botRowSubtitle,
  filterRosterRows,
  rosterCapabilityNotes,
  rosterEmptyView,
  type PublicBot,
  type RosterRow,
} from '@/lib/gateway/bots';
import {
  filterGroupRooms,
  groupMemberLine,
  MIN_GROUP_MEMBERS,
  type BotGroupRoom,
} from '@/lib/gateway/groups';
import { rosterBotTap } from '@/lib/gateway/roster-tap';
import { TAB_ROSTER_BASE_PADDING, tabContentPaddingBottom } from '@/lib/motion/tab-insets';

export type ChatRosterProps = {
  rows: RosterRow[];
  loading?: boolean;
  error?: string;
  /** Gate-owned group rooms; absent on gateways that do not advertise them. */
  groups?: BotGroupRoom[];
  /**
   * Staleness or unread copy for the rooms inventory. Independent of the
   * agent-inventory `error` — a rooms blip must not look like agents failed.
   */
  groupsError?: string;
  onSelectConfigurable: () => void;
  onSelectBot: (bot: PublicBot) => void;
  /**
   * Long-press a roster row: the detail surface (description, pin, routing fix, id).
   * Also opened by TAPPING an unroutable row — the subtitle names the verdict,
   * so the tap must hand over the fix instead of doing nothing.
   */
  onBotDetail?: (bot: PublicBot) => void;
  onSelectGroup?: (group: BotGroupRoom) => void;
  /**
   * Long-press a group row: the room action sheet (member line, open, rename,
   * disband) without entering the room first.
   */
  onGroupDetail?: (group: BotGroupRoom) => void;
  /** Present only when the gateway's client can create and edit agents at all. */
  onNewAgent?: () => void;
  /** Present only when the gateway can create rooms (bots endpoint + groups advertised). */
  onNewGroup?: () => void;
  /** Whether the client can manage agents at all — drives the honest capability note when "New Agent" is hidden. */
  canManageAgents?: boolean;
  /** Whether the gateway can host Gate-owned group rooms right now — drives the note when "New Group Room" is hidden. */
  canHostGroups?: boolean;
  /**
   * Pull-to-refresh: re-read the inventories (agents + rooms). Absent when
   * there is nothing to re-read (gateway not connected) — then no spinner
   * is offered at all instead of one that always fails.
   */
  onRefresh?: () => Promise<void> | void;
};

export function ChatRoster({
  rows,
  loading = false,
  error,
  groups = [],
  groupsError,
  onSelectConfigurable,
  onSelectBot,
  onBotDetail,
  onSelectGroup,
  onGroupDetail,
  onNewAgent,
  onNewGroup,
  canManageAgents = false,
  canHostGroups = false,
  onRefresh,
}: ChatRosterProps) {
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const tokens = useTokens();
  const insets = useSafeAreaInsets();

  // The spinner holds for a beat even on fast reads so the gesture always
  // feels acknowledged — same floor as the thread surface's refresh.
  const handleRefresh = onRefresh
    ? () => {
        setRefreshing(true);
        const started = Date.now();
        void Promise.resolve(onRefresh()).finally(() => {
          const elapsed = Date.now() - started;
          setTimeout(() => setRefreshing(false), elapsed < 400 ? 400 - elapsed : 0);
        });
      }
    : undefined;

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
  const visibleGroups = filterGroupRooms(groups, query);
  const visibleBotCount = visibleRows.filter((row) => row.kind === 'bot').length;
  const totalBotCount = rows.filter((row) => row.kind === 'bot').length;
  const emptyView = rosterEmptyView({
    totalBotRows: totalBotCount,
    visibleBotRows: visibleBotCount,
    visibleGroups: visibleGroups.length,
    query,
    error,
  });
  // Same verdicts that gate the creation rows: a hidden row gets one honest
  // line about why, exactly where the row would have sat.
  const capabilityNotes = rosterCapabilityNotes({
    hasBotManagement: canManageAgents,
    hasGroupRooms: canHostGroups,
  });
  const routableBots = rows.filter(
    (row): row is Extract<RosterRow, { kind: 'bot' }> => row.kind === 'bot' && row.bot.routable,
  );

  return (
    <ScrollView
      contentContainerStyle={[styles.pad, { paddingBottom: tabContentPaddingBottom({ platform: Platform.OS, insetBottom: insets.bottom, base: TAB_ROSTER_BASE_PADDING }) }]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      refreshControl={
        handleRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={tokens.accentWarm}
            colors={[tokens.accentWarm]}
            progressBackgroundColor={tokens.backgroundElevated}
          />
        ) : undefined
      }
    >
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
            onPress={rosterBotTap(row.bot, {
              onChat: () => onSelectBot(row.bot),
              onDetail: onBotDetail ? () => onBotDetail(row.bot) : undefined,
            })}
            onLongPress={onBotDetail ? () => onBotDetail(row.bot) : undefined}
            style={styles.row}
          />
        );
      })}
      {groupsError ? (
        <Text variant="caption" color="secondary" style={styles.error}>
          {groupsError}
        </Text>
      ) : null}
      {visibleGroups.length > 0 ? (
        <Text variant="caption" color="tertiary" style={styles.sectionLabel}>
          GROUP ROOMS
        </Text>
      ) : null}
      {visibleGroups.map((group) => (
        <ListRow
          key={group.id}
          title={group.name}
          subtitle={groupMemberLine(group)}
          leading={<BotAvatar botId={group.id} />}
          onPress={onSelectGroup ? () => onSelectGroup(group) : undefined}
          onLongPress={onGroupDetail ? () => onGroupDetail(group) : undefined}
          style={styles.row}
        />
      ))}
      {onNewAgent ? (
        <ListRow
          title="New Agent"
          subtitle="Name, soul, keys, and model pin"
          icon={{ ios: 'plus.circle', android: 'add_circle', web: 'add_circle' }}
          onPress={onNewAgent}
          style={styles.row}
        />
      ) : null}
      {onNewGroup && routableBots.length >= MIN_GROUP_MEMBERS ? (
        <ListRow
          title="New Group Room"
          subtitle="2–6 bots reply in rounds to one message"
          icon={{ ios: 'person.3', android: 'groups', web: 'groups' }}
          onPress={onNewGroup}
          style={styles.row}
        />
      ) : null}
      {capabilityNotes.map((note) => (
        <Text key={note} variant="caption" color="secondary" style={styles.capability}>
          {note}
        </Text>
      ))}
      {emptyView.kind === 'zero-bots' ? (
        <EmptyState
          icon={{ ios: 'person.crop.circle', android: 'person', web: 'person' }}
          title="No bots on this gateway"
          description="Named Hermes profiles appear here once the Gate can inventory them."
        />
      ) : null}
      {emptyView.kind === 'load-failed' ? (
        <EmptyState
          icon={{ ios: 'exclamationmark.triangle', android: 'warning', web: 'warning' }}
          title="Couldn't load agents"
          description="The roster could not read this gateway's agent inventory — the reason is named above."
        />
      ) : null}
      {emptyView.kind === 'no-match' ? (
        <EmptyState
          icon={{ ios: 'magnifyingglass', android: 'search', web: 'search' }}
          title={`No agents match "${emptyView.query}"`}
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
  search: { marginBottom: Spacing.two, minHeight: 48 },
  row: { marginBottom: Spacing.one },
  gap: { marginTop: Spacing.two },
  error: { marginBottom: Spacing.two },
  sectionLabel: { marginTop: Spacing.three, marginBottom: Spacing.one + 2, paddingHorizontal: Spacing.one },
  capability: { marginTop: Spacing.two },
});
