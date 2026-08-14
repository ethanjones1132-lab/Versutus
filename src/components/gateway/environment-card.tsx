import { StyleSheet, View } from 'react-native';

import { Badge, Button, Card, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import type { EnvironmentSnapshot } from '@/lib/gateway/environment-types';

export function EnvironmentCard({
  environment,
  onCheck,
  onStart,
  onStop,
  onRun,
}: {
  environment: EnvironmentSnapshot;
  onCheck: () => void;
  onStart: () => void;
  onStop: () => void;
  onRun: () => void;
}) {
  return (
    <Card padding={Spacing.three} style={styles.card}>
      <Text variant="title">{environment.label}</Text>
      <Text variant="caption">{environment.adapterId} · {environment.executable.path}</Text>
      <Badge label={environment.state} tone={environment.state === 'ready' ? 'success' : 'neutral'} />
      <Text variant="caption">
        {environment.probe?.protocol ?? environment.protocolPreference.join(', ')}
        {environment.probe?.cliVersion ? ` · ${environment.probe.cliVersion}` : ''}
      </Text>
      <Text variant="caption">providers {environment.providerRefs.join(', ') || 'none'}</Text>
      <Text variant="caption">
        {environment.workspacePolicy.defaultSandbox} · {environment.workspacePolicy.defaultRoot}
      </Text>
      <Text variant="caption">Interactive operations require desktop presence.</Text>
      <View style={styles.actions}>
        <Button label="Check" variant="secondary" onPress={onCheck} />
        <Button label="Start" variant="secondary" onPress={onStart} />
        <Button label="Stop" variant="secondary" onPress={onStop} />
        <Button label="Run" variant="secondary" onPress={onRun} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.two, marginBottom: Spacing.three },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
});
