import { StyleSheet, View } from 'react-native';

import * as Haptics from 'expo-haptics';

import { Badge, Button, Card, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { environmentPrimaryAction } from '@/lib/gateway/entity-actions';
import type { EnvironmentSnapshot } from '@/lib/gateway/environment-types';

export type EnvironmentCardProps = {
  environment: EnvironmentSnapshot;
  onCheck: () => void;
  onStart: () => void;
  onStop: () => void;
  onRun: () => void;
};

export function EnvironmentCard({ environment, onCheck, onStart, onStop, onRun }: EnvironmentCardProps) {
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
        <Button label="Run" variant="secondary" onPress={onRun} style={styles.primary} />
      </View>
      <Text variant="micro" color="tertiary">Interactive operations require desktop presence.</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two, marginBottom: Spacing.three },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  titles: { flex: 1, minWidth: 0, gap: 2 },
  actions: { flexDirection: 'row', gap: Spacing.two },
  primary: { flex: 1 },
});
