import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import * as Haptics from 'expo-haptics';

import { ProviderActionsSheet } from '@/components/gateway/provider-actions-sheet';
import { Badge, Button, Card, Icon, PressableScale, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { providerPrimaryAction } from '@/lib/gateway/entity-actions';
import type { ProviderSnapshot } from '@/lib/gateway/provider-types';
import { providerUiState } from '@/lib/gateway/provider-state';

export type ProviderCardProps = {
  snapshot: ProviderSnapshot;
  onCheck: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
  onDisable: () => void;
  onDelete: () => void;
  onSetKey: () => void;
  onAuthorize: () => void;
  onEnable: () => void;
};

export function ProviderCard(props: ProviderCardProps) {
  const { snapshot } = props;
  const [actionsVisible, setActionsVisible] = useState(false);
  const label = providerUiState(snapshot);
  const primary = providerPrimaryAction(snapshot);
  const ready = label === 'Ready';

  const handlers: Record<string, () => void> = {
    'set-key': props.onSetKey,
    authorize: props.onAuthorize,
    check: props.onCheck,
    refresh: props.onRefresh,
    enable: props.onEnable,
  };

  const modelCount = snapshot.catalog.models.length;
  const catalogNote =
    snapshot.catalog.state === 'unavailable'
      ? 'no catalog yet'
      : `${modelCount} model${modelCount === 1 ? '' : 's'} · ${snapshot.catalog.source === 'live' ? 'live' : 'last known good'}`;

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <View style={styles.header}>
        <View style={styles.titles}>
          <Text variant="title" numberOfLines={1}>{snapshot.label}</Text>
          <Text variant="caption" color="tertiary" numberOfLines={1}>
            {snapshot.providerType} · {catalogNote}
          </Text>
        </View>
        <Badge label={label} tone={ready ? 'success' : label === 'Not configured' ? 'accent' : 'neutral'} />
      </View>

      {snapshot.readiness.message ? (
        <Text variant="caption" color="tertiary" numberOfLines={3}>
          {snapshot.readiness.message}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Button
          label={primary.label}
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            handlers[primary.id]?.();
          }}
          style={styles.primary}
        />
        <PressableScale
          onPress={() => setActionsVisible(true)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`More actions for ${snapshot.label}`}
          style={styles.overflow}>
          <Icon name={{ ios: 'ellipsis', android: 'more_vert', web: 'more_vert' }} size={18} color="textSecondary" />
        </PressableScale>
      </View>

      <ProviderActionsSheet
        visible={actionsVisible}
        label={snapshot.label}
        onClose={() => setActionsVisible(false)}
        onSetKey={props.onSetKey}
        onAuthorize={props.onAuthorize}
        onCheck={props.onCheck}
        onRefresh={props.onRefresh}
        onDisconnect={props.onDisconnect}
        onDisable={props.onDisable}
        onDelete={props.onDelete}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two, marginBottom: Spacing.three },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  titles: { flex: 1, minWidth: 0, gap: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  primary: { flex: 1 },
  overflow: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
