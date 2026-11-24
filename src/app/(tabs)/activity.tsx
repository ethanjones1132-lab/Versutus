import { DrawerMenuButton } from '@/components/nav/drawer-menu-button';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RoutinesSection } from '@/components/activity/routines-section';
import { TodaySection } from '@/components/activity/today-section';
import { PulsingDot } from '@/components/connection-badge';
import { AppHeader, ErrorCard, Screen, SegmentedControl, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useHeaderScrolled } from '@/hooks/use-header-scrolled';
import { useTokens } from '@/hooks/use-tokens';
import { useAmbientParallaxScroll } from '@/lib/motion/ambient-parallax';
import { screenEdgesFor } from '@/lib/motion/screen-edges';
import { tabContentPaddingBottom } from '@/lib/motion/tab-insets';
/** Activity's Today feed and cross-backend routine list. */
export default function ActivityScreen() {
  const router = useRouter();
  const tokens = useTokens();
  const {
    activeGateway,
    status,
    requestRunFocus,
    selectSession,
    refreshPendingApprovals,
  } = useGateway();

  const [refreshing, setRefreshing] = useState(false);
  // A refused refresh read is named below the header instead of ending the
  // spinner as if the pull succeeded; cleared by the next success.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [todayReloadSignal, setTodayReloadSignal] = useState(0);
  // The Routines view reads the cross-backend feed, not the cron roster: its
  // own signal so filing a job from the form there re-reads the feed it shows.
  const [routinesReloadSignal, setRoutinesReloadSignal] = useState(0);
  const [activityView, setActivityView] = useState<'today' | 'routines'>('today');
  const ambient = useAmbientParallaxScroll();
  const { scrolled, onScroll } = useHeaderScrolled(ambient.onScroll);
  const insets = useSafeAreaInsets();
  // Any run on Activity opens Runs *on that run*: the same door a run
  // notice uses, so Runs finds it, scrolls to it and lights its edge.
  const openRun = useCallback(
    (runId: string) => {
      requestRunFocus({ runId });
      router.push('/runs');
    },
    [requestRunFocus, router],
  );

  const onRefresh = async () => {
    setRefreshing(true);
    const started = Date.now();
    try {
      // Refresh the approvals inbox first; Today and Routines own their reads
      // and coalesce this signal with any request already in flight.
      await refreshPendingApprovals();
      setRefreshError(null);
    } catch (caught) {
      setRefreshError(caught instanceof Error ? caught.message : String(caught));
    }
    setTodayReloadSignal((n) => n + 1);
    setRoutinesReloadSignal((n) => n + 1);
    // Hold the spinner briefly so recovery isn't a disorienting flash.
    const elapsed = Date.now() - started;
    if (elapsed < 400) await new Promise((resolve) => setTimeout(resolve, 400 - elapsed));
    setRefreshing(false);
  };

  return (
    <Screen edges={screenEdgesFor({ platform: Platform.OS, hasDock: true })} parallaxY={ambient.parallaxY}>
      <AppHeader
        variant="page"
        title="Activity"
        inset={Spacing.four - 4}
        leading={<DrawerMenuButton />}
        scrolled={scrolled}
        status={
          <>
            <PulsingDot
              color={status === 'connected' ? tokens.statusConnected : tokens.textTertiary}
              active={status === 'connecting' || status === 'reconnecting'}
            />
            <Text variant="caption" color="secondary">
              {status === 'connected'
                ? `Live${activeGateway ? ` · ${activeGateway.name}` : ''}`
                : 'Offline — showing what this phone last saw'}
            </Text>
          </>
        }
      />
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
            tintColor={tokens.accent}
            colors={[tokens.accent]}
            progressBackgroundColor={tokens.backgroundElevated}
          />

        }>
        <View style={styles.header}>
          <SegmentedControl
            options={[{ key: 'today', label: 'Today' }, { key: 'routines', label: 'Routines' }]}
            selectedKey={activityView}
            onSelect={setActivityView}
          />

          {refreshError ? (
            <ErrorCard
              cause={refreshError}
              affected="Activity's approvals inbox"
              next="Retry the refresh."
              onRetry={() => void onRefresh()}
              onDismiss={() => setRefreshError(null)}
            />
          ) : null}

          {activityView === 'today' ? (
            <TodaySection
              reloadSignal={todayReloadSignal}
              onOpenRun={openRun}
              onOpenSession={({ sessionId, backendId, botId }) => {
                // The same door the session sheet uses: validate, switch the
                // thread, then show it. The row's own backend and Bot travel
                // with the tap so it opens that exact scope, never the
                // conversation that happened to be selected.
                selectSession(sessionId, { backendId, botId });
                router.push('/chat');
              }}
            />
          ) : null}
        </View>

      <View style={styles.footer}>
        {activityView === 'routines' ? (
          <RoutinesSection reloadSignal={routinesReloadSignal} />
        ) : null}
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
    paddingHorizontal: Spacing.four - 4,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.four,
    gap: Spacing.four,
    flexGrow: 1,
  },
  header: {
    gap: Spacing.four,
  },
  footer: {
    gap: Spacing.four,
  },
});
