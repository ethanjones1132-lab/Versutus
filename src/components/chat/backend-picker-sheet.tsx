import { useCallback } from 'react';
import { FlatList, StyleSheet } from 'react-native';

import { Badge, BaseSheet, EmptyState, ListRow, Text } from '@/components/ui';
import { Spacing, Radius } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { GatewayBackend } from '@/lib/portal/manifest';

export type BackendPickerSheetProps = {
  visible: boolean;
  backends: GatewayBackend[];
  selectedBackendId?: string;
  onSelect: (backendId: string) => void;
  onClose: () => void;
};

/** Switching backend switches sessions, models and tools — so it says so. */
export function BackendPickerSheet({
  visible,
  backends,
  selectedBackendId,
  onSelect,
  onClose,
}: BackendPickerSheetProps) {
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
          onPress={() => {
            onSelect(item.id);
            onClose();
          }}
        />
      );
    },
    [onClose, onSelect, selectedBackendId, tokens],
  );

  if (!visible) return null;

  return (
    <BaseSheet visible={visible} eyebrow="CHAT" title="Chat backend" onClose={onClose} closeLabel="Dismiss">
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
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  blurb: { paddingHorizontal: Spacing.two, paddingBottom: Spacing.two },
});
