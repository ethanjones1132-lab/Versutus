import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Badge, Button, Card, Screen, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  clearFailures,
  loadFailures,
  type FailureEntry,
} from '@/lib/diagnostics/failure-log';
import { formatRelativeTime } from '@/lib/format';
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
  const [failures, setFailures] = useState<FailureEntry[]>([]);

  const globals = useMemo(() => probeRuntimeGlobals(), []);

  // What this phone has already failed at, read once on arrival. It is the
  // section an operator opens this screen FOR after a crash: the probes above
  // say what the engine can do, this says what actually went wrong here.
  useEffect(() => {
    let cancelled = false;
    void loadFailures().then((loaded) => {
      if (!cancelled) setFailures(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const clearRecorded = useCallback(async () => {
    await clearFailures();
    setFailures([]);
  }, []);

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
            busy={running}
            style={styles.button}
          />
        </Card>

        <Card variant="inset" padding={Spacing.three} style={styles.card}>
          <Text variant="headline">Recent failures</Text>
          <Text variant="caption" color="secondary" style={styles.detail}>
            Crashes, uncaught errors and rejected promises recorded on this phone. Kept
            on the device only — nothing is sent anywhere.
          </Text>
          {failures.length === 0 ? (
            <Text variant="caption" color="tertiary" style={styles.detail}>
              No failures recorded
            </Text>
          ) : (
            failures.map((failure, index) => (
              <View key={`${failure.at}-${index}`} style={styles.failure}>
                <View style={styles.row}>
                  <Text variant="caption" color="tertiary" style={styles.failureKind}>
                    {`${formatRelativeTime(failure.at)} · ${failure.kind}`}
                  </Text>
                  {failure.count > 1 ? (
                    <Badge label={`×${failure.count}`} tone="neutral" />
                  ) : null}
                </View>
                <Text variant="caption" color="secondary" numberOfLines={3}>
                  {failure.message}
                </Text>
              </View>
            ))
          )}
          <Button
            label="Clear"
            variant="secondary"
            size="sm"
            onPress={() => void clearRecorded()}
            disabled={failures.length === 0}
            style={styles.button}
          />
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.four, gap: Spacing.three },
  card: { gap: Spacing.one },
  blurb: { marginTop: Spacing.one },
  summary: { flexDirection: 'row', marginTop: Spacing.two },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  rowLabel: { flexShrink: 1 },
  detail: { marginTop: Spacing.one },
  button: { marginTop: Spacing.two },
  failure: { marginTop: Spacing.two, gap: Spacing.one },
  failureKind: { flexShrink: 1 },
});
