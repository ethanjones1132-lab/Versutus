import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Badge, Button, Card, Screen, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  probeRuntimeGlobals,
  probeStreamingFetch,
  type EnvironmentCheck,
} from '@/lib/runtime-environment';

/**
 * What this build's engine can actually do, checked on the device.
 *
 * Streaming chat and the Shell tab were broken on device for the whole time the
 * test suite, the type check and a live pass against the real gateway were all
 * green — every one of them runs in Node, where the Web APIs exist. This screen
 * is the missing loop, so it deliberately ships in release builds rather than
 * living under `src/app/dev/`, which redirects away outside __DEV__.
 */
export default function GatewayDiagnosticsScreen() {
  const { activeGateway } = useGateway();
  const [liveCheck, setLiveCheck] = useState<EnvironmentCheck | null>(null);
  const [running, setRunning] = useState(false);

  const globals = useMemo(() => probeRuntimeGlobals(), []);

  const healthUrl = activeGateway
    ? `${activeGateway.url.replace(/\/+$/, '')}/health`
    : null;

  const runLive = useCallback(async () => {
    if (!healthUrl) return;
    setRunning(true);
    try {
      setLiveCheck(await probeStreamingFetch(healthUrl));
    } finally {
      setRunning(false);
    }
  }, [healthUrl]);

  const checks = liveCheck ? [...globals, liveCheck] : globals;
  const brokenCritical = checks.filter((check) => check.critical && !check.ok);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Card variant="hero" padding={Spacing.three} style={styles.card}>
          <Text variant="title">Runtime environment</Text>
          <Text variant="body" color="secondary" style={styles.blurb}>
            What this build&apos;s JavaScript engine provides. Tests run in Node, where
            all of this exists — only the device can answer for the device.
          </Text>
          <View style={styles.summary}>
            <Badge
              label={brokenCritical.length === 0 ? 'No known breakage' : `${brokenCritical.length} broken`}
              tone={brokenCritical.length === 0 ? 'success' : 'danger'}
            />
          </View>
        </Card>

        {checks.map((check) => (
          <Card key={check.id} variant="surface" padding={Spacing.three} style={styles.card}>
            <View style={styles.row}>
              <Text variant="headline" style={styles.rowLabel}>
                {check.label}
              </Text>
              <Badge
                label={check.ok ? 'ok' : check.critical ? 'broken' : 'absent'}
                tone={check.ok ? 'success' : check.critical ? 'danger' : 'neutral'}
              />
            </View>
            <Text variant="caption" color="secondary" style={styles.detail}>
              {check.detail}
            </Text>
          </Card>
        ))}

        <Card variant="inset" padding={Spacing.three} style={styles.card}>
          <Text variant="headline">Live check</Text>
          <Text variant="caption" color="secondary" style={styles.detail}>
            {healthUrl
              ? `Reads ${healthUrl} incrementally. This is the exact capability whose absence broke streaming — the globals above cannot answer it.`
              : 'Connect a gateway to run the live check.'}
          </Text>
          <Button
            label={running ? 'Checking…' : 'Run live check'}
            onPress={runLive}
            disabled={!healthUrl || running}
            style={styles.button}
          />
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.three, gap: Spacing.two },
  card: { gap: Spacing.one },
  blurb: { marginTop: Spacing.one },
  summary: { flexDirection: 'row', marginTop: Spacing.two },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  rowLabel: { flexShrink: 1 },
  detail: { marginTop: Spacing.one },
  button: { marginTop: Spacing.two },
});
