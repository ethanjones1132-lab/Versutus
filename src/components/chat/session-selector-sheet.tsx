import * as Haptics from 'expo-haptics';
import { useCallback } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { BaseSheet, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { entering } from '@/lib/motion/presets';
import { useTokens } from '@/hooks/use-tokens';

type SessionItem = {
  id: string;
  title?: string;
  status?: string;
  updatedAt?: number;
  numMessages?: number;
};

export function SessionSelectorSheet({
  visible,
  sessions,
  currentSessionId,
  onSelect,
  onClose,
  onRefresh,
}: {
  visible: boolean;
  sessions: SessionItem[];
  currentSessionId?: string;
  onSelect: (sessionId: string) => void;
  onClose: () => void;
  onRefresh?: () => void;
}) {
  const tokens = useTokens();

  const renderSessionItem = useCallback(({ item }: { item: SessionItem }) => {
    if (item.id === 'no-sessions') {
      return <Text style={{ padding: Spacing.two }} color="tertiary">{item.title}</Text>;
    }
    const isCurrent = item.id === currentSessionId;
    return (
      <Animated.View entering={entering.fadeIn}>
        <PressableScale
          style={[styles.sessionCard, isCurrent && { borderColor: tokens.accentWarm }]}
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onSelect(item.id);
          }}
        >
          <Text variant="body" numberOfLines={1}>{item.id}</Text>
          {item.title && <Text variant="caption" color="tertiary">{item.title}</Text>}
          <View style={styles.meta}>
            {item.status && <Text variant="caption">{item.status}</Text>}
            {item.numMessages !== undefined && <Text variant="caption">{item.numMessages} msgs</Text>}
            {isCurrent && <Text variant="caption" color="accentWarm">current</Text>}
          </View>
        </PressableScale>
      </Animated.View>
    );
  }, [currentSessionId, onSelect, tokens.accentWarm]);

  if (!visible) return null;

  return (
    <BaseSheet
      visible={visible}
      eyebrow="SESSION SELECTOR"
      title="Select a session"
      onClose={onClose}
      closeLabel="Done"
      position="bottom"
    >
      {currentSessionId && (
        <Text color="secondary" style={styles.current}>Current: {currentSessionId}</Text>
      )}

      <FlatList
        data={sessions.length ? sessions : [{ id: 'no-sessions', title: 'No sessions found. Use /session list' }]}
        keyExtractor={(item) => item.id}
        style={styles.list}
        renderItem={renderSessionItem}
        removeClippedSubviews
      />

      {onRefresh && (
        <PressableScale
          style={{ alignSelf: 'flex-end', marginTop: Spacing.two }}
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onRefresh();
          }}>
          <Text variant="caption" color="accent">Refresh sessions</Text>
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
  sessionCard: {
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: Radius.md,
    padding: Spacing.two,
    marginBottom: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(240,214,144,0.15)',
  },
  meta: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
});
