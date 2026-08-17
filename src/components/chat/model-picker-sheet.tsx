import * as Haptics from 'expo-haptics';
import { useCallback, useMemo, useState } from 'react';
import { SectionList, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Badge, BaseSheet, Button, EmptyState, Icon, PressableScale, Text, TextField } from '@/components/ui';
import { filterModels } from '@/lib/gateway/model-selection';
import { Radius, Spacing } from '@/constants/tokens';
import { entering } from '@/lib/motion/presets';
import { useTokens } from '@/hooks/use-tokens';

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

type ModelSection = {
  key: string;
  title: string;
  data: ModelItem[];
};

const OTHER_GROUP_KEY = 'other';

function formatContext(context?: number): string | undefined {
  if (!context) return undefined;
  if (context >= 1000) return `${Math.round(context / 1000)}k ctx`;
  return `${context} ctx`;
}

function groupByProvider(models: ModelItem[]): ModelSection[] {
  const groups = new Map<string, ModelSection>();
  for (const model of models) {
    const key = model.providerId ?? model.provider ?? OTHER_GROUP_KEY;
    const title = model.provider ?? model.providerId ?? 'Other';
    const existing = groups.get(key);
    if (existing) {
      existing.data.push(model);
    } else {
      groups.set(key, { key, title, data: [model] });
    }
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
}

export function ModelPickerSheet({
  visible,
  models,
  currentDefault,
  mode = 'default',
  agentId,
  onSelect,
  onClose,
  onRefresh,
}: {
  visible: boolean;
  models: ModelItem[];
  currentDefault?: string;
  mode?: 'default' | 'fallbacks' | 'agent';
  agentId?: string;
  onSelect: (modelId: string, providerId?: string) => void;
  onClose: () => void;
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
              onSelect(item.id, item.providerId ?? item.provider);
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
    ({ section }: { section: ModelSection }) => {
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

  if (!visible) return null;

  const title =
    mode === 'agent' && agentId
      ? `Model for agent ${agentId}`
      : mode === 'fallbacks'
        ? 'Fallback models'
        : 'Apply model';

  return (
    <BaseSheet visible={visible} eyebrow="MODEL PICKER" title={title} onClose={onClose} closeLabel="Done" position="bottom">
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
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  list: {
    flexGrow: 0,
    paddingHorizontal: Spacing.two,
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
  refresh: {
    alignSelf: 'flex-end',
    marginTop: Spacing.one,
  },
});
