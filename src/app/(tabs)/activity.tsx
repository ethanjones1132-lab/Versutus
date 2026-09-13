import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AgentTargets } from '@/components/activity/agent-targets';
import { ApprovalDecisionCard } from '@/components/activity/approval-decision-card';
import { CronSection } from '@/components/activity/cron-section';
import { SpendEntryRow } from '@/components/gateway/spend-entry-row';
import { Badge, Button, Card, Screen, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import { useAmbientParallaxScroll } from '@/lib/motion/ambient-parallax';
import { screenEdgesFor } from '@/lib/motion/screen-edges';
import { tabContentPaddingBottom } from '@/lib/motion/tab-insets';

/**
 * The scheduled-work view. Workflows slice 3b extracted the individual run
 * surface (the start card, the windowed run list and the post-run scorecards)
 * to its own `/runs` destination; this tab keeps the gateway's cron jobs, the
 * pending approval and the gateway-wide reads, with one control into Runs.
 */
export default function ActivityScreen() {
  const router = useRouter();
  const tokens = useTokens();
  const {
    activeGateway,
    gateways,
    status,
    pendingRunApproval,
    resolveRunApproval,
    connectGateway,
    refreshCapabilities,
    refreshGateways,
  } = useGateway();

  const [refreshing, setRefreshing] = useState(false);
  // A pull-to-refresh re-reads capabilities + gateways but not cron jobs
  // (CronSection loads once per connection); bumping this signal reaches
  // the section's re-list without remounting the tab.
  const [cronReloadSignal, setCronReloadSignal] = useState(0);
  const { parallaxY, onScroll } = useAmbientParallaxScroll();
  const insets = useSafeAreaInsets();

  const onRefresh = async () => {
    setRefreshing(true);
    const started = Date.now();
    await Promise.all([refreshCapabilities(), refreshGateways()]).catch(() => undefined);
    setCronReloadSignal((n) => n + 1);
    // Hold the spinner briefly so recovery isn't a disorienting flash.
    const elapsed = Date.now() - started;
    if (elapsed < 400) await new Promise((resolve) => setTimeout(resolve, 400 - elapsed));
    setRefreshing(false);
  };

  return (
    <Screen edges={screenEdgesFor({ platform: Platform.OS, hasDock: false })} parallaxY={parallaxY}>
      <ScrollView
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: tabContentPaddingBottom({ platform: Platform.OS, insetBottom: insets.bottom }) },
        ]}
        onScroll={onScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={tokens.accentWarm}
            colors={[tokens.accentWarm]}
            progressBackgroundColor={tokens.backgroundElevated}
          />
        }>
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <Text variant="title">Activity</Text>
            <Badge
              label={status === 'connected' ? 'Live' : 'Offline'}
              tone={status === 'connected' ? 'success' : 'neutral'}
            />
          </View>

          {/* Workflows slice 3b: runs have their own destination, so this is
              the scheduled-work view rather than a run list. */}
          <Card padding={Spacing.three} style={styles.runsEntryCard}>
            <Text variant="body" color="secondary">
              Scheduled work is here. Individual runs have their own screen.
            </Text>
            <Button
              label="Open runs"
              variant="ghost"
              size="sm"
              onPress={() => router.push('/runs')}
            />
          </Card>

          {pendingRunApproval ? (
            <ApprovalDecisionCard
              runId={pendingRunApproval.runId}
              prompt={pendingRunApproval.prompt}
              onResolve={(approved, feedback) => resolveRunApproval(approved, feedback)}
            />
          ) : null}
        </View>

      <View style={styles.footer}>
      <CronSection cronReloadSignal={cronReloadSignal} />

      {/* Spend is the gateway-wide readout, so it sits with the gateway-wide
          work. Renders nothing while no connection can answer it. */}
      <SpendEntryRow />

      <AgentTargets
        gateways={gateways}
        activeGatewayId={activeGateway?.id}
        status={status}
        onSelect={(gateway) => {
          void connectGateway(gateway);
        }}
      />
      </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.four,
    gap: Spacing.three,
    flexGrow: 1,
  },
  header: {
    gap: Spacing.three,
  },
  footer: {
    gap: Spacing.three,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  runsEntryCard: {
    gap: Spacing.two,
  },
});
