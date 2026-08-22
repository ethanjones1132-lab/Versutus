import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import * as Haptics from 'expo-haptics';

import { EnvironmentActionsSheet } from '@/components/gateway/environment-actions-sheet';
import { Badge, Button, Card, Icon, PressableScale, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { environmentPrimaryAction } from '@/lib/gateway/entity-actions';
import type { EnvironmentSnapshot } from '@/lib/gateway/environment-types';

export type EnvironmentCardProps = {
  environment: EnvironmentSnapshot;
  onCheck: () => void;
  onStart: () => void;
  onStop: () => void;
  onRun: () => void;
  onEdit: () => void;
  onRemove: () => void;
};

export function EnvironmentCard({ environment, onCheck, onStart, onStop, onRun, onEdit, onRemove }: EnvironmentCardProps) {
  const [actionsVisible, setActionsVisible] = useState(false);
  const primary = environmentPrimaryAction(environment);
  const handlers: Record<string, () => void> = { start: onStart, stop: onStop, check: onCheck };
  const healthy = environment.state === 'ready';
  const protocol = environment.probe?.protocol ?? environment.protocolPreference.join(', ');

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <View style={styles.header}>
        <View style={styles.titles}>
          <Text variant="title" numberOfLines={1}>{environment.label}</Text>
          <Text variant="caption" color="tertiary" numberOfLines={1}>
            {environment.adapterId}
            {environment.probe?.cliVersion ? ` ${environment.probe.cliVersion}` : ''} · {protocol}
          </Text>
        </View>
        <Badge label={environment.state} tone={healthy ? 'success' : 'neutral'} />
      </View>

      <Text variant="caption" color="tertiary" numberOfLines={2}>
        {environment.workspacePolicy.defaultSandbox} · {environment.workspacePolicy.defaultRoot}
      </Text>
      <Text variant="caption" color="tertiary">
        {environment.providerRefs.length > 0
          ? `Bound providers: ${environment.providerRefs.join(', ')}`
          : 'Uses its own credentials — no Gate provider bound.'}
      </Text>

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
          accessibilityLabel={`More actions for ${environment.label}`}
          style={styles.overflow}>
          <Icon name={{ ios: 'ellipsis', android: 'more_vert', web: 'more_vert' }} size={18} color="textSecondary" />
        </PressableScale>
      </View>
      <Text variant="micro" color="tertiary">Interactive operations require desktop presence.</Text>

      <EnvironmentActionsSheet
        visible={actionsVisible}
        label={environment.label}
        onClose={() => setActionsVisible(false)}
        onCheck={onCheck}
        onStart={onStart}
        onStop={onStop}
        onRun={onRun}
        onEdit={onEdit}
        onRemove={onRemove}
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
