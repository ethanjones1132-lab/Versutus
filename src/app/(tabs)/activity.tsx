import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { AgentTargets } from '@/components/activity/agent-targets';
import { RunCard } from '@/components/activity/run-card';
import { Badge, Button, Card, EmptyState, Icon, Screen, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';

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
  } = useGateway();

  const activeRuns = activityRuns.filter((run) => run.status === 'running' || run.status === 'waiting-approval');
  const finishedRuns = activityRuns.filter((run) => !activeRuns.includes(run));

  const decide = async (approved: boolean) => {
    await Haptics.notificationAsync(
      approved ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
    );
    resolveRunApproval(approved);
  };

  return (
    <Screen edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.titleRow}>
          <Text variant="title">Activity</Text>
          <Badge
            label={status === 'connected' ? 'Live' : 'Offline'}
            tone={status === 'connected' ? 'success' : 'neutral'}
          />
        </View>

        {pendingRunApproval ? (
          <Card
            variant="hero"
            padding={Spacing.three}
            style={[styles.approvalCard, { borderColor: tokens.accentWarm }]}>
            <View style={styles.approvalHeader}>
              <Icon
                name={{ ios: 'hand.raised.fill', android: 'pan_tool', web: 'pan_tool' }}
                size={16}
                color="accentWarm"
              />
              <Text variant="caption" color="accentWarm" style={styles.approvalEyebrow}>
                Approval requested
              </Text>
            </View>
            <Text variant="body" numberOfLines={3}>
              {pendingRunApproval.prompt}
            </Text>
            <Text variant="mono" color="tertiary" numberOfLines={1}>
              run {pendingRunApproval.runId}
            </Text>
            <View style={styles.approvalActions}>
              <Button label="Approve" onPress={() => void decide(true)} style={styles.approvalButton} />
              <Button
                label="Deny"
                variant="destructive"
                onPress={() => void decide(false)}
                style={styles.approvalButton}
              />
            </View>
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
            title={activeGateway ? 'No runs yet' : 'Nothing to watch yet'}
            description={
              activeGateway
                ? 'Runs you start from chat (try /run) show up here with live events and approval gates.'
                : 'Connect to a gateway, then start a run from chat with /run.'
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
  approvalCard: {
    borderRadius: Radius.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
    gap: Spacing.two,
  },
  approvalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  approvalEyebrow: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  approvalActions: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  approvalButton: {
    flex: 1,
  },
  section: {
    gap: Spacing.two,
  },
  sectionTitle: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
});
