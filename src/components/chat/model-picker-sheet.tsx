import * as Haptics from 'expo-haptics';
import { useCallback } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { BaseSheet, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { entering } from '@/lib/motion/presets';
import { useTokens } from '@/hooks/use-tokens';

type ModelItem = {
  id: string;
  provider?: string;
  available?: boolean;
  context?: number;
  price?: number;
  auth?: string;
  usage?: string;
};

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
  onSelect: (modelId: string) => void;
  onClose: () => void;
  onRefresh?: () => void;
}) {
  const tokens = useTokens();

  const renderModelItem = useCallback(({ item }: { item: ModelItem }) => (
    <Animated.View entering={entering.fadeIn}>
      <PressableScale
        style={[
          styles.modelCard,
          {
            backgroundColor: tokens.backgroundInset,
            borderColor: tokens.glassBorder,
          },
        ]}
        onPress={async () => {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onSelect(item.id);
        }}
      >
      <View style={styles.modelHeader}>
        <Text variant="body" numberOfLines={1}>{item.id}</Text>
        {item.provider && <Text variant="caption" color="tertiary">({item.provider})</Text>}
      </View>
      <View style={styles.modelMeta}>
        {item.auth && <Text variant="caption">Auth: {item.auth}</Text>}
        {item.available !== undefined && (
          <Text variant="caption" color={item.available ? 'accentWarm' : 'tertiary'}>
            {item.available ? 'Available' : 'Locked'}
          </Text>
        )}
        {item.context && <Text variant="caption">ctx {item.context}</Text>}
        {item.price !== undefined && <Text variant="caption">${item.price}</Text>}
      </View>
      {item.usage && <Text variant="caption" color="tertiary">{item.usage}</Text>}
      </PressableScale>
    </Animated.View>
  ), [onSelect, tokens.backgroundInset, tokens.glassBorder]);

  if (!visible) return null;

  const title = mode === 'agent' && agentId 
    ? `Select model for agent: ${agentId}`
    : mode === 'fallbacks' 
      ? 'Select fallback models' 
      : 'Select default model';

  return (
    <BaseSheet
      visible={visible}
      eyebrow="MODEL PICKER"
      title={title}
      onClose={onClose}
      closeLabel="Done"
      position="bottom"
    >
      {currentDefault && (
        <Text color="secondary" style={styles.current}>Current: {currentDefault}</Text>
      )}

      {models.length === 0 ? (
        <Text color="tertiary" style={{ padding: Spacing.three }}>
          No models available. Use /model list or tap Refresh.
        </Text>
      ) : (
        <FlatList
          data={models}
          keyExtractor={(item) => item.id}
          style={styles.list}
          renderItem={renderModelItem}
          removeClippedSubviews
        />
      )}

      {onRefresh && (
        <PressableScale
          style={{ alignSelf: 'flex-end', marginTop: Spacing.two }}
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onRefresh();
          }}>
          <Text variant="caption" color="accent">Refresh catalog</Text>
        </PressableScale>
      )}
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  current: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  list: {
    flex: 1,
    paddingHorizontal: Spacing.three,
  },
  modelCard: {
    borderRadius: Radius.md,
    padding: Spacing.two,
    marginBottom: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
  },
  modelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modelMeta: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
});
