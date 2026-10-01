// ─── While-you-were-away digest ───────────────────────────────────
// The Home card half of FUTURE-ITEMS §1b. The pure selection and copy live
// in `@/lib/home/briefing`; this renders their verdict above the gateway
// list. The window is the ACTIVE gateway's lastSeenAt, read on arrival and
// held for the whole visit, so the card speaks only to the absence before
// it. The stamp is then advanced to this arrival, so the NEXT arrival's
// window starts here rather than at the last leave.
//
// Honesty: nothing here is a result. Each line counts runs the device
// recorded and repeats that run's own status. No stamp, or no news since
// it, renders nothing rather than a placeholder card — but a stamp this
// device could not read says so and offers a retry, because a blank card
// reads as "nothing happened" and this device does not know that.

import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Icon, PressableScale, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { buildHomeBriefing, homeBriefingSummary } from '@/lib/home/briefing';
import { readLastSeen, stampLastSeen, type LastSeenRead } from '@/lib/home/last-seen';

/** How long a refused stamp read waits before the one retry this visit gets. */
const READ_RETRY_MS = 1000;

/** The row an unreadable stamp gets, and what a screen reader is told. */
const STAMP_UNREADABLE_COPY = "Couldn't check what changed while you were away - tap to retry";
const STAMP_UNREADABLE_LABEL = 'Could not check what changed while you were away. Tap to retry.';

/**
 * What this visit's window is: the stamp as read on arrival, or why there is
 * none. Held in component state rather than re-read, so a run that finishes
 * while the card is showing cannot move the window under the operator's eyes.
 */
type VisitWindow =
  | { state: 'never' }
  | { state: 'ok'; lastSeenAt: number; visitStartedAt: number }
  | { state: 'error' };

export function HomeBriefingCard() {
  const router = useRouter();
  const { activeGateway, activityRunsForActiveGateway } = useGateway();
  const activeGatewayId = activeGateway?.id ?? null;
  const [visit, setVisit] = useState<VisitWindow | null>(null);
  // A read already in flight when the screen loses focus must not paint; the
  // flag and the pending retry timer outlive the focus effect so a tap retry
  // can join the same pair.
  const reading = useRef({ cancelled: false, timer: null as ReturnType<typeof setTimeout> | null });

  const adopt = useCallback(
    (read: LastSeenRead, gatewayId: string) => {
      if (read.state === 'never') {
        setVisit({ state: 'never' });
        return;
      }
      if (read.state === 'error') {
        setVisit({ state: 'error' });
        return;
      }
      const visitStartedAt = Date.now();
      setVisit({ state: 'ok', lastSeenAt: read.at, visitStartedAt });
      // Written only once THIS visit's digest has been read: the next window
      // opens at this arrival, so nothing already shown repeats, and a run
      // that finishes while the card is up belongs to the next one.
      void stampLastSeen(gatewayId, visitStartedAt);
    },
    [],
  );

  const readWindow = useCallback(() => {
    const gatewayId = activeGatewayId;
    if (!gatewayId) {
      setVisit({ state: 'never' });
      return;
    }
    const pending = reading.current;
    void readLastSeen(gatewayId).then((read) => {
      if (pending.cancelled) return;
      // One silent retry before the refusal is shown: an unreadable stamp is a
      // fact about storage, not proof that nothing happened.
      if (read.state !== 'error') {
        adopt(read, gatewayId);
        return;
      }
      pending.timer = setTimeout(() => {
        void readLastSeen(gatewayId).then((again) => {
          if (!pending.cancelled) adopt(again, gatewayId);
        });
      }, READ_RETRY_MS);
    });
  }, [activeGatewayId, adopt]);

  // Read the stamp on arrival, then advance it to this arrival. The native tab
  // keeps Home mounted across tab switches, so focus — not mount — is the real
  // "operator is here again" edge (home.tsx stamps the leave). Writing on
  // arrival is what stops the same news re-printing on every return to Home,
  // and what keeps the in-visit window from sliding while the card is up.
  useFocusEffect(
    useCallback(() => {
      const pending = reading.current;
      pending.cancelled = false;
      readWindow();
      return () => {
        pending.cancelled = true;
        if (pending.timer) clearTimeout(pending.timer);
        pending.timer = null;
      };
    }, [readWindow]),
  );

  const retry = useCallback(() => {
    const pending = reading.current;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    readWindow();
  }, [readWindow]);

  const summary = useMemo(() => {
    if (!visit || visit.state !== 'ok') return null;
    const briefing = buildHomeBriefing(
      activityRunsForActiveGateway,
      visit.lastSeenAt,
      // `now` is this visit's own start: a run that finishes while the card is
      // showing is not news from the operator's absence, so it waits for the
      // next visit rather than being labelled "While you were away".
      visit.visitStartedAt,
    );
    return briefing ? homeBriefingSummary(briefing) : null;
  }, [activityRunsForActiveGateway, visit]);

  // No stamp means no window; no news means no card. Either way, nothing —
  // except a stamp this device could not read, which is not the same fact and
  // gets a row that says so and retries on tap.
  if (visit?.state === 'error') {
    return (
      <PressableScale
        onPress={retry}
        accessibilityRole="button"
        accessibilityLabel={STAMP_UNREADABLE_LABEL}
        style={styles.retry}>
        <Text variant="caption" color="secondary">
          {STAMP_UNREADABLE_COPY}
        </Text>
      </PressableScale>
    );
  }
  if (!summary || summary.isEmpty) return null;

  return (
    <Card variant="hero" padding={Spacing.three} style={styles.card}>
      <View style={styles.header}>
        <Icon
          name={{ ios: 'clock', android: 'schedule', web: 'schedule' }}
          size={16}
          color="accent"
        />
        <Text variant="eyebrow" color="tertiary" style={styles.eyebrow}>
          While you were away
        </Text>
      </View>
      {summary.lines.map((line) => (
        <Text key={line} variant="body" color="secondary">
          {line}
        </Text>
      ))}
      <Button
        label="Open Activity"
        variant="secondary"
        size="sm"
        onPress={() => router.push('/activity')}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  eyebrow: {
    flexShrink: 1,
  },
  retry: {
    paddingVertical: Spacing.two,
  },
});
