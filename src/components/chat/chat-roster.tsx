import { memo, useState, useCallback } from 'react';
import { FlatList, Platform, RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BotAvatar, GroupAvatar } from '@/components/chat/bot-avatar';
import { PulsingDot, statusColor } from '@/components/connection-badge';
import { Button, EmptyState, Icon, PressableScale, Skeleton, Text, TextField, type IconName } from '@/components/ui';
import { FontFamily, Radius, Spacing } from '@/constants/tokens';
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
  type BotGroupRoom,
} from '@/lib/gateway/groups';
import { botReportedRoutable, rosterBotTap } from '@/lib/gateway/roster-tap';
import type { ConnectionStatus } from '@/lib/gateway/types';
import { haptics } from '@/lib/haptics';
import { gateLineFor, greetingFor } from '@/lib/home/greeting';
import { TAB_ROSTER_BASE_PADDING, tabContentPaddingBottom } from '@/lib/motion/tab-insets';

export type ChatRosterProps = {
  rows: RosterRow[];
  loading?: boolean;
  error?: string;
  /**
   * Whether the gateway is connected — the roster read is gated on a live
   * connection, so `false` means the read has not run. The footer must then
   * wait for it instead of reporting a count nobody measured.
   */
  connected: boolean;
  /** Gate-owned group rooms; absent on gateways that do not advertise them. */
  groups?: BotGroupRoom[];
  /**
   * Staleness or unread copy for the rooms inventory. Independent of the
   * agent-inventory `error` — a rooms blip must not look like agents failed.
   */
  groupsError?: string;
  /**
   * The line for a shared text this roster is holding: there is no thread up
   * to take it, so the operator's own tap on a row is what decides which
   * composer the words land in. Authored by the module that holds the request
   * (`composeRequestHoldCopy`) — absent where nothing is held, so the roster
   * draws no copy of its own about it.
   */
  heldShareCopy?: string;
  /** The Gate's name, for the line under the greeting. */
  gatewayName?: string;
  /** The Gate's connection, for the same line and its dot. */
  status?: ConnectionStatus;
  /** Opens the Gate's own screen from the line under the greeting. */
  onGatePress?: () => void;
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
  /** Present only when the gateway can host a handoff import (bots endpoint). */
  onImportAgent?: () => void;
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

/**
 * One Bot's line in the roster: its purpose when the Gate reports one, else
 * the routing verdict. An unroutable Bot always reads its verdict — the fix is
 * one tap away and the operator must see why before they tap.
 */
function botPurpose(bot: PublicBot): string {
  if (!botReportedRoutable(bot)) return botRowSubtitle(bot);
  const description = bot.description?.trim();
  if (!description) return botRowSubtitle(bot);
  // The first sentence is the Bot's job title; the rest belongs to its panel.
  // A job title reads without its full stop; a question or exclamation keeps its mark.
  const first = description.match(/^[^.!?]+[.!?]?/)?.[0] ?? description;
  return first.trim().replace(/\.$/, '');
}

/**
 * The greeting with its one permitted flourish: the last word set in the
 * italic serif ("Good *evening*"). Nocturne allows italic serif for exactly
 * one emphasised word inside a display line, and nowhere else.
 */
function Greeting({ text }: { text: string }) {
  const split = text.lastIndexOf(' ');
  if (split < 0) return <Text variant="display">{text}</Text>;
  return (
    <Text variant="display">
      {text.slice(0, split + 1)}
      <Text variant="display" style={styles.greetingItalic}>
        {text.slice(split + 1)}
      </Text>
    </Text>
  );
}

/**
 * A roster member: crest, name, one line of purpose, and a quiet trailing
 * note. No chevron — the whole row is the door, as it is in any messages list.
 */
function RosterMemberRow({
  leading,
  title,
  subtitle,
  trailing,
  onPress,
  onLongPress,
  attention = false,
}: {
  leading: React.ReactNode;
  title: string;
  subtitle: string;
  trailing?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  attention?: boolean;
}) {
  return (
    <PressableScale
      onPress={
        onPress
          ? async () => {
              await haptics.selection();
              onPress();
            }
          : undefined
      }
      onLongPress={
        onLongPress
          ? async () => {
              await haptics.selection();
              onLongPress();
            }
          : undefined
      }
      disabled={!onPress && !onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${subtitle}`}
      style={styles.member}>
      {leading}
      <View style={styles.memberText}>
        <View style={styles.memberTitleRow}>
          <Text variant="callout" numberOfLines={1} style={styles.memberName}>
            {title}
          </Text>
          {trailing ? (
            <Text variant="micro" color="tertiary" numberOfLines={1} style={styles.memberTrailing}>
              {trailing}
            </Text>
          ) : null}
        </View>
        <Text
          variant="caption"
          color={attention ? 'statusConnecting' : 'secondary'}
          numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
    </PressableScale>
  );
}

/**
 * A creation action at the foot of the roster, drawn in the roster's own
 * rhythm: a quiet inset tile where a crest would sit, the action's name, and
 * one plain line of what it makes. It reads as the next seat at the table,
 * not a toolbar.
 */
function RosterAction({
  title,
  subtitle,
  icon,
  onPress,
}: {
  title: string;
  subtitle: string;
  icon: IconName;
  onPress: () => void;
}) {
  const tokens = useTokens();
  return (
    <PressableScale
      onPress={async () => {
        await haptics.selection();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={subtitle}
      style={styles.member}>
      <View style={[styles.actionTile, { backgroundColor: tokens.backgroundElevated }]}>
        <Icon name={icon} size={18} color="secondary" />
      </View>
      <View style={styles.memberText}>
        <Text variant="callout" numberOfLines={1} style={styles.memberName}>
          {title}
        </Text>
        <Text variant="caption" color="tertiary" numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
    </PressableScale>
  );
}

function ChatRosterImpl({
  rows,
  loading = false,
  error,
  connected,
  groups = [],
  groupsError,
  heldShareCopy,
  gatewayName,
  status,
  onGatePress,
  onSelectConfigurable,
  onSelectBot,
  onBotDetail,
  onSelectGroup,
  onGroupDetail,
  onNewAgent,
  onImportAgent,
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

  const renderItem = useCallback(
    ({ item }: { item: RosterItem }) => {
      if (item.kind === 'group') {
        return (
          <View>
            {item.showSectionLabel ? (
              <Text variant="eyebrow" color="tertiary" style={styles.sectionLabel}>
                Rooms
              </Text>
            ) : null}
            <RosterMemberRow
              key={item.group.id}
              title={item.group.name}
              subtitle={groupMemberLine(item.group)}
              leading={<GroupAvatar memberIds={item.group.memberIds} size={44} />}
              onPress={onSelectGroup ? () => onSelectGroup(item.group) : undefined}
              onLongPress={onGroupDetail ? () => onGroupDetail(item.group) : undefined}
            />
          </View>
        );
      }
      const row = item.row;
      if (row.kind === 'configurable') {
        return (
          <PressableScale
            key="configurable"
            onPress={onSelectConfigurable}
            accessibilityRole="button"
            accessibilityLabel="Direct chat. Talk to any model, no Bot in between."
            style={styles.member}>
            <View style={[styles.directTile, { backgroundColor: tokens.accentMuted }]}>
              <Icon name={{ ios: 'sparkles', android: 'auto_awesome', web: 'auto_awesome' }} size={20} color="accent" />
            </View>
            <View style={styles.memberText}>
              <Text variant="callout" numberOfLines={1} style={styles.memberName}>
                Direct chat
              </Text>
              <Text variant="caption" color="secondary" numberOfLines={1}>
                Talk to any model, no Bot in between
              </Text>
            </View>
          </PressableScale>
        );
      }
      const routable = botReportedRoutable(row.bot);
      return (
        <RosterMemberRow
          key={row.bot.id}
          title={row.bot.displayName}
          subtitle={botPurpose(row.bot)}
          attention={!routable}
          leading={
            <BotAvatar botId={row.bot.id} name={row.bot.displayName} size={44} attention={!routable} />
          }
          onPress={rosterBotTap(row.bot, {
            onChat: () => onSelectBot(row.bot),
            onDetail: onBotDetail ? () => onBotDetail(row.bot) : undefined,
          })}
          onLongPress={onBotDetail ? () => onBotDetail(row.bot) : undefined}
        />
      );
    },
    [onSelectGroup, onGroupDetail, onSelectConfigurable, onSelectBot, onBotDetail, tokens.accentMuted],
  );

  if (loading && rows.length <= 1) {
    return (
      <View style={styles.pad}>
        <Skeleton width="62%" height={40} />
        <Skeleton width="44%" height={14} style={styles.gapSmall} />
        <Skeleton width="100%" height={60} style={styles.gap} />
        <Skeleton width="100%" height={60} style={styles.gap} />
        <Skeleton width="100%" height={60} style={styles.gap} />
      </View>
    );
  }

  const visibleRows = filterRosterRows(rows, query);
  const visibleGroups = filterGroupRooms(groups, query);
  const visibleBotCount = visibleRows.filter((row) => row.kind === 'bot').length;
  const totalBotCount = rows.filter((row) => row.kind === 'bot').length;
  const readyBotCount = rows.filter(
    (row) => row.kind === 'bot' && botReportedRoutable(row.bot),
  ).length;
  const emptyView = rosterEmptyView({
    totalBotRows: totalBotCount,
    visibleBotRows: visibleBotCount,
    visibleGroups: visibleGroups.length,
    query,
    error,
    connected,
  });
  // Same verdicts that gate the creation rows: a hidden row gets one honest
  // line about why, exactly where the row would have sat.
  const capabilityNotes = rosterCapabilityNotes({
    hasBotManagement: canManageAgents,
    hasGroupRooms: canHostGroups,
  });
  const gateLine =
    gatewayName && status
      ? gateLineFor({ gatewayName, status, readyBots: readyBotCount, totalBots: totalBotCount })
      : undefined;

  // FlatList data: the configurable row, every visible bot row, then every
  // visible group room. Only these rows virtualize — search, errors, the
  // creation rows, capability notes and empty states stay fixed in the
  // header/footer so a 200-bot roster mounts only the rows on screen instead
  // of the whole ScrollView at once per streamed frame (iter-090).
  const items: RosterItem[] = [
    ...visibleRows.map(
      (row): RosterItem => ({ key: rowKindKey(row), kind: 'row', row }),
    ),
    ...visibleGroups.map(
      (group, index): RosterItem => ({
        key: group.id,
        kind: 'group',
        group,
        showSectionLabel: index === 0,
      }),
    ),
  ];

  return (
    <FlatList<RosterItem>
      data={items}
      keyExtractor={(item) => item.key}
      renderItem={renderItem}
      contentContainerStyle={[styles.pad, { paddingBottom: tabContentPaddingBottom({ platform: Platform.OS, insetBottom: insets.bottom, base: TAB_ROSTER_BASE_PADDING }) }]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      removeClippedSubviews
      initialNumToRender={12}
      maxToRenderPerBatch={16}
      windowSize={9}
      refreshControl={
        handleRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={tokens.accent}
            colors={[tokens.accent]}
            progressBackgroundColor={tokens.backgroundElevated}
          />
        ) : undefined
      }
      ListHeaderComponent={
        <View>
          <View style={styles.hero}>
            <Greeting text={greetingFor(new Date())} />
            {gateLine && status ? (
              <PressableScale
                onPress={onGatePress}
                disabled={!onGatePress}
                hitSlop={8}
                accessibilityRole={onGatePress ? 'button' : undefined}
                accessibilityLabel={onGatePress ? `${gateLine}. Open the Gate.` : gateLine}
                style={styles.gateLine}>
                <PulsingDot
                  color={statusColor(tokens, status)}
                  active={status === 'connecting' || status === 'reconnecting'}
                />
                <Text variant="caption" color="secondary" numberOfLines={1} style={styles.gateText}>
                  {gateLine}
                </Text>
              </PressableScale>
            ) : null}
          </View>
          {heldShareCopy ? (
            <Text variant="caption" color="secondary" style={styles.heldShare}>
              {heldShareCopy}
            </Text>
          ) : null}
          {rows.length > 1 ? (
            <TextField
              value={query}
              onChangeText={setQuery}
              placeholder="Search your team"
              returnKeyType="search"
              style={[styles.search, { backgroundColor: tokens.stageGlass, borderTopColor: tokens.specular }]}
            />
          ) : null}
          {error ? (
            <Text variant="caption" color="secondary" style={styles.error}>
              {error}
            </Text>
          ) : null}
          {groupsError ? (
            <Text variant="caption" color="secondary" style={styles.error}>
              {groupsError}
            </Text>
          ) : null}
          {groupsError && handleRefresh ? (
            <Button label="Retry" variant="ghost" size="sm" onPress={handleRefresh} />
          ) : null}
          {items.length > 0 ? (
            <Text variant="eyebrow" color="tertiary" style={styles.sectionLabel}>
              Your team
            </Text>
          ) : null}
        </View>
      }
      ListFooterComponent={
        <View>
          {/* A failed read leads: with an empty list body this block is the
              first thing below the header reason, before any creation row. */}
          {emptyView.kind === 'load-failed' ? (
            <EmptyState
              icon={{ ios: 'exclamationmark.triangle', android: 'warning', web: 'warning' }}
              title="Couldn't load agents"
              description="The roster could not read this gateway's agent inventory — the reason is named above."
              actionLabel="Retry"
              onAction={handleRefresh}
            />
          ) : null}
          {onNewAgent || onImportAgent || onNewGroup ? (
            <View style={styles.actions}>
              <Text variant="eyebrow" color="tertiary" style={styles.sectionLabel}>
                Grow the team
              </Text>
              {onNewAgent ? (
                <RosterAction
                  title="New Agent"
                  subtitle="Name, soul, keys, and model pin"
                  icon={{ ios: 'plus', android: 'add', web: 'add' }}
                  onPress={onNewAgent}
                />
              ) : null}
              {/* Under the two-bot floor the sheet itself names the floor and
                  refuses Create — hiding the row only hid that honest copy. */}
              {onNewGroup ? (
                <RosterAction
                  title="New Group Room"
                  subtitle="2–6 bots reply in rounds to one message"
                  icon={{ ios: 'person.3', android: 'groups', web: 'groups' }}
                  onPress={onNewGroup}
                />
              ) : null}
              {/* D6's other half: a packet exported from another host, read back
                  here. Offered only where the gateway can create the Bot it names. */}
              {onImportAgent ? (
                <RosterAction
                  title="Import handoff"
                  subtitle="Create a Bot from an exported packet"
                  icon={{ ios: 'square.and.arrow.down', android: 'download', web: 'download' }}
                  onPress={onImportAgent}
                />
              ) : null}
            </View>
          ) : null}
          {capabilityNotes.map((note) => (
            <Text key={note} variant="caption" color="tertiary" style={styles.capability}>
              {note}
            </Text>
          ))}
          {emptyView.kind === 'waiting' ? (
            <EmptyState
              icon={{ ios: 'clock', android: 'schedule', web: 'schedule' }}
              title="Waiting for connection"
              description="The roster is read as soon as the gateway connects."
            />
          ) : null}
          {emptyView.kind === 'zero-bots' ? (
            <EmptyState
              icon={{ ios: 'person.crop.circle', android: 'person', web: 'person' }}
              title="No bots on this gateway"
              description="Named Hermes profiles appear here once the Gate can inventory them."
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
        </View>
      }
    />
  );
}

/** One stable key per roster row for the windowed list. */
function rowKindKey(row: RosterRow): string {
  return row.kind === 'configurable' ? 'configurable' : row.bot.id;
}

/** A single windowed row: a bot/configurable agent row or a group room. */
type RosterItem =
  | { key: string; kind: 'row'; row: RosterRow }
  | { key: string; kind: 'group'; group: BotGroupRoom; showSectionLabel: boolean };

export const ChatRoster = memo(ChatRosterImpl);
ChatRoster.displayName = 'ChatRoster';

const styles = StyleSheet.create({
  pad: { paddingHorizontal: Spacing.four - 4, paddingTop: Spacing.one, paddingBottom: Spacing.five },
  hero: { gap: Spacing.two, paddingHorizontal: Spacing.one, paddingTop: Spacing.two, paddingBottom: Spacing.four },
  gateLine: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, alignSelf: 'flex-start' },
  gateText: { flexShrink: 1 },
  search: {
    marginBottom: Spacing.three,
    minHeight: 48,
    borderRadius: Radius.full,
    borderWidth: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sectionLabel: { marginTop: Spacing.two, marginBottom: Spacing.one, paddingHorizontal: Spacing.one },
  member: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 2,
    paddingVertical: Spacing.two + 2,
    paddingHorizontal: Spacing.one,
    minHeight: 64,
    borderRadius: Radius.lg,
  },
  memberText: { flex: 1, minWidth: 0, gap: 2 },
  memberTitleRow: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.two },
  memberName: { flex: 1, fontSize: 16, lineHeight: 21 },
  memberTrailing: { flexShrink: 0, maxWidth: 120 },
  directTile: {
    width: 44,
    height: 44,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: { marginTop: Spacing.three },
  actionTile: {
    width: 44,
    height: 44,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  greetingItalic: { fontFamily: FontFamily.serifItalic },
  gap: { marginTop: Spacing.three },
  gapSmall: { marginTop: Spacing.two },
  error: { marginBottom: Spacing.two },
  heldShare: { marginBottom: Spacing.two },
  capability: { marginTop: Spacing.three, paddingHorizontal: Spacing.one },
});
