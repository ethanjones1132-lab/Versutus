import * as Haptics from 'expo-haptics';
import { useCallback } from 'react';
import { Alert, FlatList, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Badge, BaseSheet, Button, EmptyState, Icon, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { formatCost, formatRelativeTime, formatTokenCount } from '@/lib/format';
import { entering } from '@/lib/motion/presets';
import { useTokens } from '@/hooks/use-tokens';

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

export function SessionSelectorSheet({
  visible,
  sessions,
  currentSessionId,
  onSelect,
  onClose,
  onRefresh,
  onNewSession,
  onDeleteSession,
}: {
  visible: boolean;
  sessions: SessionItem[];
  currentSessionId?: string;
  onSelect: (sessionId: string) => void;
  onClose: () => void;
  onRefresh?: () => void;
  onNewSession?: () => void;
  onDeleteSession?: (sessionId: string) => void;
}) {
  const tokens = useTokens();

  const confirmDelete = useCallback(
    (item: SessionItem) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert('Delete session?', `"${item.title ?? item.id}" is removed from the gateway.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete session',
          style: 'destructive',
          onPress: () => onDeleteSession?.(item.id),
        },
      ]);
    },
    [onDeleteSession],
  );

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
              onSelect(item.id);
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

  if (!visible) return null;

  return (
    <BaseSheet
      visible={visible}
      eyebrow="SESSION SELECTOR"
      title="Sessions"
      onClose={onClose}
      closeLabel="Done"
      position="bottom">
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

      {sessions.length === 0 ? (
        <EmptyState
          icon={{ ios: 'bubble.left.and.bubble.right', android: 'chat', web: 'chat' }}
          title="No sessions yet"
          description="Start a new session or send a message — the gateway creates one for you."
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

      {onRefresh && sessions.length > 0 ? (
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
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
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
});
