import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { AgentTargets } from '@/components/activity/agent-targets';
import { ApprovalDecisionCard } from '@/components/activity/approval-decision-card';
import { RunCard } from '@/components/activity/run-card';
import { Badge, Button, Card, EmptyState, Screen, Text } from '@/components/ui';
import { FontFamily, Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import { useAmbientParallaxScroll } from '@/lib/motion/ambient-parallax';

export default function ActivityScreen() {
  const router = useRouter();
  const tokens = useTokens();
  const {
    activeGateway,
    gateways,
    status,
    activityRuns,
    stopActivityRun,
    pendingRunApproval,
    resolveRunApproval,
    connectGateway,
    capabilitySnapshot,
    refreshCapabilities,
    refreshGateways,
    sendChatInput,
  } = useGateway();

  const [runPrompt, setRunPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { parallaxY, onScroll } = useAmbientParallaxScroll();

  const activeRuns = activityRuns.filter((run) => run.status === 'running' || run.status === 'waiting-approval');
  const finishedRuns = activityRuns.filter((run) => !activeRuns.includes(run));
  const runsSupported =
    status === 'connected' &&
    capabilitySnapshot.groups.find((group) => group.id === 'agent')?.status === 'ready';
  const runsUnsupported =
    status === 'connected' &&
    capabilitySnapshot.groups.find((group) => group.id === 'agent')?.status === 'unsupported';

  const startRun = async () => {
    const prompt = runPrompt.trim();
    if (!prompt || !runsSupported || starting) return;
    setStarting(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      // Route through slash so Activity + chat command bubble stay consistent.
      await sendChatInput(`/run ${prompt}`);
      setRunPrompt('');
    } finally {
      setStarting(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    const started = Date.now();
    await Promise.all([refreshCapabilities(), refreshGateways()]).catch(() => undefined);
    // Hold the spinner briefly so recovery isn't a disorienting flash.
    const elapsed = Date.now() - started;
    if (elapsed < 400) await new Promise((resolve) => setTimeout(resolve, 400 - elapsed));
    setRefreshing(false);
  };

  return (
    <Screen parallaxY={parallaxY}>
      <ScrollView
        contentContainerStyle={styles.content}
        onScroll={onScroll}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={tokens.accentWarm}
            colors={[tokens.accentWarm]}
            progressBackgroundColor={tokens.backgroundElevated}
          />
        }>
        <View style={styles.titleRow}>
          <Text variant="title">Activity</Text>
          <Badge
            label={status === 'connected' ? 'Live' : 'Offline'}
            tone={status === 'connected' ? 'success' : 'neutral'}
          />
        </View>

        {pendingRunApproval ? (
          <ApprovalDecisionCard
            runId={pendingRunApproval.runId}
            prompt={pendingRunApproval.prompt}
            onResolve={(approved) => resolveRunApproval(approved)}
          />
        ) : null}

        {runsSupported ? (
          <Card padding={Spacing.three} style={styles.startCard}>
            <Text variant="caption" color="accentWarm" style={styles.approvalEyebrow}>
              Start a run
            </Text>
            <Text variant="body" color="secondary">
              Agentic task with live events and approval gates. Tracks here while it runs.
            </Text>
            <TextInput
              value={runPrompt}
              onChangeText={setRunPrompt}
              placeholder="Describe the task…"
              placeholderTextColor={tokens.textTertiary}
              multiline
              style={[
                styles.runInput,
                {
                  color: tokens.textPrimary,
                  borderColor: tokens.glassBorder,
                  backgroundColor: tokens.backgroundInset,
                },
              ]}
              editable={!starting && status === 'connected'}
              accessibilityLabel="Run prompt"
            />
            <Button
              label={starting ? 'Starting…' : 'Run task'}
              onPress={() => void startRun()}
              disabled={!runPrompt.trim() || starting || status !== 'connected'}
            />
          </Card>
        ) : null}

        {activeRuns.length > 0 ? (
          <View style={styles.section}>
            <Text variant="caption" color="secondary" style={styles.sectionTitle}>
              In flight
            </Text>
            {activeRuns.map((run) => (
              <RunCard key={run.id} run={run} onStop={stopActivityRun} />
            ))}
          </View>
        ) : null}

        {finishedRuns.length > 0 ? (
          <View style={styles.section}>
            <Text variant="caption" color="secondary" style={styles.sectionTitle}>
              Recent runs
            </Text>
            {finishedRuns.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </View>
        ) : null}

        <AgentTargets
          gateways={gateways}
          activeGatewayId={activeGateway?.id}
          status={status}
          onSelect={(gateway) => {
            void connectGateway(gateway).then(() => router.push('/chat'));
          }}
        />

        {activityRuns.length === 0 && !pendingRunApproval ? (
          <EmptyState
            icon={{ ios: 'bolt', android: 'bolt', web: 'bolt' }}
            title={
              !activeGateway
                ? 'Nothing to watch yet'
                : runsUnsupported
                  ? 'Runs not offered'
                  : status !== 'connected'
                    ? 'Connect to start runs'
                    : 'No runs yet'
            }
            description={
              !activeGateway
                ? 'Connect to a gateway that supports agentic runs, then start one here or with /run in chat.'
                : runsUnsupported
                  ? `${activeGateway.name} is chat-only (or has no run API). Chat still works; agentic runs need Hermes /v1/runs.`
                  : status !== 'connected'
                    ? 'Reconnect, then start a run from this screen or Chat → overflow → Run task.'
                    : 'Start a run above, use Chat overflow → Run task, or type /run <prompt> in chat.'
            }
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.four,
    gap: Spacing.three,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  approvalEyebrow: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  startCard: {
    gap: Spacing.two,
  },
  runInput: {
    minHeight: 72,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontFamily: FontFamily.sans,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  section: {
    gap: Spacing.two,
  },
  sectionTitle: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
});
