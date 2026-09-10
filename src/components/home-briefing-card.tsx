// ─── While-you-were-away digest ───────────────────────────────────
// The Home card half of FUTURE-ITEMS §1b. The pure selection and copy live
// in `@/lib/home/briefing`; this renders their verdict above the gateway
// list. The window is the ACTIVE gateway's lastSeenAt, written when the
// operator left Home, so the card speaks only to the visit it is between.
//
// Honesty: nothing here is a result. Each line counts runs the device
// recorded and repeats that run's own status. No stamp, or no news since
// it, renders nothing rather than a placeholder card.

import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Icon, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { buildHomeBriefing, homeBriefingSummary } from '@/lib/home/briefing';
import { loadLastSeen } from '@/lib/home/last-seen';

export function HomeBriefingCard() {
  const router = useRouter();
  const { activeGateway, activityRuns } = useGateway();
  const activeGatewayId = activeGateway?.id ?? null;
  const [lastSeenAt, setLastSeenAt] = useState<number | null>(null);

  // Read the stamp on arrival. The native tab keeps Home mounted across tab
  // switches, so focus — not mount — is the real "operator is here again"
  // edge; the stamp itself was written when they left (index.tsx).
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (!activeGatewayId) {
        setLastSeenAt(null);
        return () => {
          cancelled = true;
        };
      }
      void loadLastSeen(activeGatewayId).then((stamp) => {
        if (!cancelled) setLastSeenAt(stamp);
      });
      return () => {
        cancelled = true;
      };
    }, [activeGatewayId]),
  );

  const summary = useMemo(() => {
    const briefing = buildHomeBriefing(activityRuns, lastSeenAt);
    return briefing ? homeBriefingSummary(briefing) : null;
  }, [activityRuns, lastSeenAt]);

  // No stamp means no window; no news means no card. Either way, nothing.
  if (!summary || summary.isEmpty) return null;

  return (
    <Card variant="hero" padding={Spacing.three} style={styles.card}>
      <View style={styles.header}>
        <Icon
          name={{ ios: 'clock', android: 'schedule', web: 'schedule' }}
          size={16}
          color="accentWarm"
        />
        <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
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
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
});
