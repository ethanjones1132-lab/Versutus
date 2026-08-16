import * as Haptics from 'expo-haptics';
import { useCallback } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Badge, BaseSheet, Button, EmptyState, PressableScale, Text } from '@/components/ui';
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

function formatContext(context?: number): string | undefined {
  if (!context) return undefined;
  if (context >= 1000) return `${Math.round(context / 1000)}k ctx`;
  return `${context} ctx`;
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

  const renderModelItem = useCallback(
    ({ item }: { item: ModelItem }) => {
      const isCurrent = item.id === currentDefault;
      const meta = [
        item.provider,
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

  if (!visible) return null;

  const title =
    mode === 'agent' && agentId
      ? `Model for agent ${agentId}`
      : mode === 'fallbacks'
        ? 'Fallback models'
        : 'Apply model';

  return (
    <BaseSheet visible={visible} eyebrow="MODEL PICKER" title={title} onClose={onClose} closeLabel="Done" position="bottom">
      {models.length === 0 ? (
        <EmptyState
          icon={{ ios: 'cpu', android: 'memory', web: 'memory' }}
          title="No models found"
          description="The gateway has not reported a model catalog yet. Refresh to ask again."
          actionLabel={onRefresh ? 'Refresh catalog' : undefined}
          onAction={onRefresh}
        />
      ) : (
        <FlatList
          data={models}
          keyExtractor={(item) => item.id}
          style={styles.list}
          renderItem={renderModelItem}
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
