import * as Haptics from 'expo-haptics';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, SectionList, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Badge, BaseSheet, Button, ConfirmSheet, EmptyState, Icon, ListRow, PressableScale, SegmentedControl, Text, TextField } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { formatCost, formatRelativeTime, formatTokenCount } from '@/lib/format';
import { entering } from '@/lib/motion/presets';
import {
  filterModels,
  groupByProvider,
  OTHER_GROUP_KEY,
  type ModelSection,
} from '@/lib/gateway/model-selection';
import type { GatewayBackend } from '@/lib/portal/manifest';
import {
  threadConfigTitle,
  type ModelPickerMode,
  type ThreadConfigMode,
} from '@/lib/gateway/thread-config';
import { useTokens } from '@/hooks/use-tokens';

/**
 * The one thread-config surface (polish roadmap 2.2): sessions, models, and
 * chat backends used to be three separate sheets stacked off three header
 * triggers. They now share this single host — each former sheet lives on as a
 * section below with its internals unchanged, and the segmented control hops
 * between sections without dismissing. Visibility stays owned where it always
 * was (provider modelPicker/sessionSelector flags + the screen-local backend
 * flag); the host renders whichever section `mode` resolves to.
 */

export type SessionItem = {
  id: string;
  title?: string;
  preview?: string;
  status?: string;
  updatedAt?: number;
  numMessages?: number;
  totalTokens?: number;
  costUsd?: number | null;
};

type ModelItem = {
  id: string;
  provider?: string;
  providerId?: string;
  available?: boolean;
  context?: number;
  price?: number;
  auth?: string;
  usage?: string;
  catalogState?: string;
};

type PickerSection = ModelSection<ModelItem>;

const SECTION_LABELS: Record<ThreadConfigMode, string> = {
  sessions: 'Sessions',
  models: 'Models',
  backends: 'Backends',
};

function formatContext(context?: number): string | undefined {
  if (!context) return undefined;
  if (context >= 1000) return `${Math.round(context / 1000)}k ctx`;
  return `${context} ctx`;
}

export type ThreadConfigSheetProps = {
  /** Active section; null renders nothing (sheet closed). */
  mode: ThreadConfigMode | null;
  /** Sections the operator may hop between; hidden when only one exists. */
  availableModes: ThreadConfigMode[];
  onModeChange: (mode: ThreadConfigMode) => void;
  onClose: () => void;
  // Sessions section
  sessions?: SessionItem[];
  /** Set when the last session-list read failed. Empty is not "No sessions yet". */
  sessionsError?: string;
  currentSessionId?: string;
  onSelectSession?: (sessionId: string) => void;
  onRefreshSessions?: () => void;
  onNewSession?: () => void;
  onDeleteSession?: (sessionId: string) => void;
  // Models section
  models?: ModelItem[];
  currentModel?: string;
  modelMode?: ModelPickerMode;
  modelAgentId?: string;
  onSelectModel?: (modelId: string, providerId?: string) => void;
  onRefreshModels?: () => void;
  // Backends section
  backends?: GatewayBackend[];
  selectedBackendId?: string;
  /** Selecting a backend also closes the sheet — switching restarts the session. */
  onSelectBackend?: (backendId: string) => void;
};

/** Formerly session-selector-sheet: list, switch, new, delete (confirm-gated). */
function SessionsSection({
  sessions = [],
  sessionsError,
  currentSessionId,
  onSelect,
  onRefresh,
  onNewSession,
  onDeleteSession,
}: {
  sessions?: SessionItem[];
  sessionsError?: string;
  currentSessionId?: string;
  onSelect?: (sessionId: string) => void;
  onRefresh?: () => void;
  onNewSession?: () => void;
  onDeleteSession?: (sessionId: string) => void;
}) {
  const tokens = useTokens();
  const [deleteCandidate, setDeleteCandidate] = useState<SessionItem | null>(null);

  const confirmDelete = useCallback((item: SessionItem) => {
    setDeleteCandidate(item);
  }, []);

  const executeDelete = useCallback(() => {
    if (deleteCandidate) {
      onDeleteSession?.(deleteCandidate.id);
    }
    setDeleteCandidate(null);
  }, [deleteCandidate, onDeleteSession]);

  const renderSessionItem = useCallback(
    ({ item }: { item: SessionItem }) => {
      const isCurrent = item.id === currentSessionId;
      const stats = [
        item.numMessages !== undefined ? `${item.numMessages} msgs` : undefined,
        item.totalTokens !== undefined && item.totalTokens > 0
          ? `${formatTokenCount(item.totalTokens)} tok`
          : undefined,
        item.costUsd != null && item.costUsd > 0 ? formatCost(item.costUsd) : undefined,
        item.updatedAt ? formatRelativeTime(item.updatedAt) : undefined,
      ]
        .filter(Boolean)
        .join(' · ');

      return (
        <Animated.View entering={entering.fadeIn}>
          <PressableScale
            style={[
              styles.sessionCard,
              {
                backgroundColor: tokens.backgroundInset,
                borderColor: isCurrent ? tokens.accentWarm : tokens.borderSubtle,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={`Switch to session ${item.title ?? item.id}`}
            onPress={async () => {
              await Haptics.selectionAsync();
              onSelect?.(item.id);
            }}>
            <View style={styles.sessionHeader}>
              <Text variant="body" numberOfLines={1} style={styles.sessionTitle}>
                {item.title ?? item.id}
              </Text>
              {isCurrent ? <Badge label="Current" tone="accent" dot={false} /> : null}
              {onDeleteSession && !isCurrent ? (
                <PressableScale
                  onPress={() => confirmDelete(item)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete session ${item.title ?? item.id}`}
                  style={styles.deleteButton}>
                  <Icon name={{ ios: 'trash', android: 'delete', web: 'delete' }} size={14} color="textTertiary" />
                </PressableScale>
              ) : null}
            </View>
            {item.preview ? (
              <Text variant="caption" color="secondary" numberOfLines={1}>
                {item.preview}
              </Text>
            ) : null}
            {stats ? (
              <Text variant="micro" color="tertiary" numberOfLines={1} style={styles.stats}>
                {stats}
              </Text>
            ) : null}
          </PressableScale>
        </Animated.View>
      );
    },
    [
      confirmDelete,
      currentSessionId,
      onDeleteSession,
      onSelect,
      tokens.accentWarm,
      tokens.backgroundInset,
      tokens.borderSubtle,
    ],
  );

  return (
    <>
      {onNewSession ? (
        <View style={styles.newRow}>
          <Button
            label="New session"
            variant="secondary"
            size="sm"
            onPress={async () => {
              await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onNewSession();
            }}
          />
        </View>
      ) : null}

      {sessionsError && sessions.length > 0 ? (
        <Text variant="caption" color="secondary" style={styles.blurb}>
          {sessionsError}
        </Text>
      ) : null}

      {sessions.length === 0 ? (
        <EmptyState
          icon={{ ios: 'bubble.left.and.bubble.right', android: 'chat', web: 'chat' }}
          title={sessionsError ?? 'No sessions yet'}
          description={
            sessionsError
              ? undefined
              : 'Start a new session or send a message — the gateway creates one for you.'
          }
          actionLabel={onNewSession ? 'New session' : undefined}
          onAction={onNewSession}
        />
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(item) => item.id}
          style={styles.list}
          renderItem={renderSessionItem}
          removeClippedSubviews
        />
      )}

      {onRefresh && (sessions.length > 0 || sessionsError) ? (
        <Button
          label="Refresh sessions"
          variant="ghost"
          size="sm"
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onRefresh();
          }}
          style={styles.refresh}
        />
      ) : null}

      <ConfirmSheet
        visible={deleteCandidate !== null}
        title="Delete session?"
        message={`"${deleteCandidate?.title ?? deleteCandidate?.id ?? ''}" is removed from the gateway.`}
        confirmLabel="Delete session"
        danger
        onCancel={() => setDeleteCandidate(null)}
        onConfirm={executeDelete}
      />
    </>
  );
}

/** Formerly model-picker-sheet: searchable, provider-grouped catalog. */
function ModelsSection({
  models = [],
  currentDefault,
  onSelect,
  onRefresh,
}: {
  models?: ModelItem[];
  currentDefault?: string;
  onSelect?: (modelId: string, providerId?: string) => void;
  onRefresh?: () => void;
}) {
  const tokens = useTokens();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');

  const searching = query.trim().length > 0;
  const visibleModels = useMemo(() => filterModels(models, query), [models, query]);
  const sections = useMemo(() => groupByProvider(visibleModels), [visibleModels]);
  const currentGroupKey = useMemo(
    () => sections.find((section) => section.data.some((item) => item.id === currentDefault))?.key,
    [sections, currentDefault],
  );
  // Default: the group holding the current model is open (or the first group); everything else collapsed.
  const fallbackExpandedKey = currentGroupKey ?? sections[0]?.key;
  const isExpanded = useCallback(
    // While searching every group is open: a match must never stay hidden
    // inside a collapsed section.
    (key: string) => (searching ? true : (expanded[key] ?? key === fallbackExpandedKey)),
    [expanded, fallbackExpandedKey, searching],
  );

  const toggleSection = useCallback(
    async (key: string) => {
      await Haptics.selectionAsync();
      setExpanded((prev) => ({ ...prev, [key]: !(prev[key] ?? key === fallbackExpandedKey) }));
    },
    [fallbackExpandedKey],
  );

  const renderModelItem = useCallback(
    ({ item }: { item: ModelItem }) => {
      const isCurrent = item.id === currentDefault;
      const meta = [
        item.catalogState,
        formatContext(item.context),
        item.price !== undefined ? `$${item.price}` : undefined,
        item.auth,
      ]
        .filter(Boolean)
        .join(' · ');

      return (
        <Animated.View entering={entering.fadeIn}>
          <PressableScale
            style={[
              styles.modelCard,
              {
                backgroundColor: tokens.backgroundInset,
                borderColor: isCurrent ? tokens.accentWarm : tokens.borderSubtle,
                opacity: item.available === false ? 0.6 : 1,
              },
            ]}
            disabled={item.available === false}
            accessibilityRole="button"
            accessibilityLabel={`Apply model ${item.id}`}
            onPress={async () => {
              await Haptics.selectionAsync();
              onSelect?.(item.id, item.providerId ?? item.provider);
            }}>
            <View style={styles.modelHeader}>
              <Text variant="body" numberOfLines={1} style={styles.modelId}>
                {item.id}
              </Text>
              {isCurrent ? (
                <Badge label="Current" tone="accent" dot={false} />
              ) : (
                <Badge
                  label={item.available === false ? 'Locked' : 'Available'}
                  tone={item.available === false ? 'neutral' : 'success'}
                  dot={false}
                />
              )}
            </View>
            {meta ? (
              <Text variant="micro" color="tertiary" numberOfLines={1} style={styles.modelMeta}>
                {meta}
              </Text>
            ) : null}
            {item.usage ? (
              <Text variant="micro" color="secondary" numberOfLines={1}>
                {item.usage}
              </Text>
            ) : null}
          </PressableScale>
        </Animated.View>
      );
    },
    [currentDefault, onSelect, tokens.backgroundInset, tokens.borderSubtle, tokens.accentWarm],
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: PickerSection }) => {
      const open = isExpanded(section.key);
      return (
        <PressableScale
          style={styles.sectionHeader}
          accessibilityRole="button"
          accessibilityLabel={`${open ? 'Collapse' : 'Expand'} ${section.title} models`}
          onPress={() => toggleSection(section.key)}>
          <Icon
            name={
              open
                ? { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }
                : { ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }
            }
            size={14}
            color={tokens.textSecondary}
          />
          <Text variant="caption" style={styles.sectionTitle}>
            {section.title}
          </Text>
          <Badge label={String(section.data.length)} tone="neutral" dot={false} />
        </PressableScale>
      );
    },
    [isExpanded, toggleSection, tokens.textSecondary],
  );

  return (
    <>
      {models.length > 1 ? (
        <TextField
          value={query}
          onChangeText={setQuery}
          placeholder="Search models or providers"
          style={styles.search}
          returnKeyType="search"
        />
      ) : null}

      {models.length === 0 ? (
        <EmptyState
          icon={{ ios: 'cpu', android: 'memory', web: 'memory' }}
          title="No models found"
          description="The gateway has not reported a model catalog yet. Refresh to ask again."
          actionLabel={onRefresh ? 'Refresh catalog' : undefined}
          onAction={onRefresh}
        />
      ) : visibleModels.length === 0 ? (
        <EmptyState
          icon={{ ios: 'magnifyingglass', android: 'search', web: 'search' }}
          title="No matches"
          description={`Nothing in the catalog matches “${query.trim()}”.`}
          actionLabel="Clear search"
          onAction={() => setQuery('')}
        />
      ) : (
        <SectionList
          sections={sections.map((section) => ({
            ...section,
            data: isExpanded(section.key) ? section.data : [],
          }))}
          keyExtractor={(item) => `${item.providerId ?? item.provider ?? OTHER_GROUP_KEY}:${item.id}`}
          style={styles.list}
          renderItem={renderModelItem}
          renderSectionHeader={renderSectionHeader}
          stickySectionHeadersEnabled={false}
          removeClippedSubviews
        />
      )}

      {onRefresh && models.length > 0 ? (
        <Button
          label="Refresh catalog"
          variant="ghost"
          size="sm"
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onRefresh();
          }}
          style={styles.refresh}
        />
      ) : null}
    </>
  );
}

/** Formerly backend-picker-sheet: switching backend switches sessions/models/tools. */
function BackendsSection({
  backends = [],
  selectedBackendId,
  onSelect,
}: {
  backends?: GatewayBackend[];
  selectedBackendId?: string;
  onSelect?: (backendId: string) => void;
}) {
  const tokens = useTokens();

  const renderItem = useCallback(
    ({ item }: { item: GatewayBackend }) => {
      const healthy = item.state === 'ready';
      const capabilities = item.capabilities ?? [];
      const detail = [
        item.adapterId,
        item.cliVersion,
        capabilities.length > 0 ? capabilities.join(' · ') : undefined,
      ]
        .filter(Boolean)
        .join(' — ');
      return (
        <ListRow
          title={item.label}
          subtitle={detail || undefined}
          chevron={false}
          statusColor={healthy ? tokens.statusConnected : tokens.textTertiary}
          trailing={<Badge label={item.state ?? 'unknown'} tone={healthy ? 'success' : 'neutral'} dot={false} />}
          style={
            item.id === selectedBackendId
              ? { borderColor: tokens.accentWarm, borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: Radius.lg }
              : undefined
          }
          onPress={() => onSelect?.(item.id)}
        />
      );
    },
    [onSelect, selectedBackendId, tokens],
  );

  return (
    <>
      <Text variant="caption" color="tertiary" style={styles.blurb}>
        Sessions, models and tools all belong to the backend. Switching starts a fresh session.
      </Text>
      {backends.length === 0 ? (
        <EmptyState
          icon={{ ios: 'terminal', android: 'terminal', web: 'terminal' }}
          title="No chat backends"
          description="Attach a CLI environment on the Gate — OpenCode, Codex or Claude Code — to converse through it."
        />
      ) : (
        <FlatList data={backends} keyExtractor={(item) => item.id} renderItem={renderItem} removeClippedSubviews />
      )}
    </>
  );
}

export function ThreadConfigSheet({
  mode,
  availableModes,
  onModeChange,
  onClose,
  sessions,
  sessionsError,
  currentSessionId,
  onSelectSession,
  onRefreshSessions,
  onNewSession,
  onDeleteSession,
  models,
  currentModel,
  modelMode,
  modelAgentId,
  onSelectModel,
  onRefreshModels,
  backends,
  selectedBackendId,
  onSelectBackend,
}: ThreadConfigSheetProps) {
  if (!mode) return null;

  const hopOptions = availableModes.filter((candidate, index) =>
    availableModes.indexOf(candidate) === index,
  );

  return (
    <BaseSheet
      visible
      eyebrow="THREAD"
      title={threadConfigTitle(mode, modelMode, modelAgentId)}
      onClose={onClose}
      closeLabel="Done"
      position="bottom">
      {hopOptions.length > 1 ? (
        <SegmentedControl
          options={hopOptions.map((candidate) => ({ key: candidate, label: SECTION_LABELS[candidate] }))}
          selectedKey={mode}
          onSelect={(next) => {
            if (next !== mode) onModeChange(next);
          }}
          style={styles.switcher}
        />
      ) : null}

      {mode === 'sessions' ? (
        <SessionsSection
          sessions={sessions}
          sessionsError={sessionsError}
          currentSessionId={currentSessionId}
          onSelect={onSelectSession}
          onRefresh={onRefreshSessions}
          onNewSession={onNewSession}
          onDeleteSession={onDeleteSession}
        />
      ) : mode === 'models' ? (
        <ModelsSection
          models={models}
          currentDefault={currentModel}
          onSelect={onSelectModel}
          onRefresh={onRefreshModels}
        />
      ) : (
        <BackendsSection
          backends={backends}
          selectedBackendId={selectedBackendId}
          onSelect={(backendId) => {
            // Selecting a backend restarts the session — close like the old
            // dedicated sheet's rows did instead of leaving the sheet up.
            onSelectBackend?.(backendId);
            onClose();
          }}
        />
      )}
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  switcher: {
    marginBottom: Spacing.two,
  },
  blurb: { paddingHorizontal: Spacing.two, paddingBottom: Spacing.two },
  newRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: Spacing.two,
    paddingBottom: Spacing.two,
  },
  list: {
    flexGrow: 0,
    paddingHorizontal: Spacing.two,
  },
  sessionCard: {
    borderRadius: Radius.md,
    padding: Spacing.two,
    marginBottom: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  sessionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  sessionTitle: {
    flex: 1,
    minWidth: 0,
  },
  deleteButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stats: {
    marginTop: 2,
  },
  refresh: {
    alignSelf: 'flex-end',
    marginTop: Spacing.one,
  },
  search: {
    marginBottom: Spacing.two,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  sectionTitle: {
    flex: 1,
    minWidth: 0,
  },
  modelCard: {
    borderRadius: Radius.md,
    padding: Spacing.two,
    marginBottom: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  modelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.two,
  },
  modelId: {
    flex: 1,
    minWidth: 0,
  },
  modelMeta: {
    marginTop: 2,
  },
});
