import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Card, Screen, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  EMPTY_SESSION_SPEND,
  SESSION_SPEND_LIST_LIMIT,
  applySessionSpendRead,
  sessionSpendCopy,
  sessionSpendReadFromUnknown,
  spendWindowCopy,
  totalUsage,
  type SessionSpendState,
} from '@/lib/gateway/session-analytics';
import { SPEND_UNREAD_COPY, spendBasisCopy, spendCostBasis } from '@/lib/gateway/spend-report';

/**
 * P5's screen: what this gateway's sessions have cost.
 *
 * One read answers it — the same `sessions.list` catalogue the thread glance
 * reads, at the same cap — and every number on screen comes from the folds
 * that read already feeds (`totalUsage`, `sessionSpendCopy`,
 * `spendWindowCopy`, `spendCostBasis` / `spendBasisCopy`). Nothing is
 * aggregated a second time here.
 *
 * A spend surface is a claim, so `applySessionSpendRead` is the only thing
 * that moves the state: an unread catalogue stays unread and is named
 * ("Spend could not be read.") rather than folded into a zero, and the cost
 * header comes from the basis the sessions actually carry — `actual`,
 * `estimated`, or `none` when the gateway reports tokens only.
 *
 * The per-Bot breakdown, the 7-day chart, the per-session table and the entry
 * points are their own slices of P5.
 */
export default function GatewaySpendScreen() {
  const { gatewayRequest, status } = useGateway();
  const [state, setState] = useState<SessionSpendState>(EMPTY_SESSION_SPEND);

  useEffect(() => {
    if (status !== 'connected') return;
    let cancelled = false;
    void gatewayRequest('sessions.list', { limit: SESSION_SPEND_LIST_LIMIT })
      .then((payload) => {
        if (cancelled) return;
        setState((previous) =>
          applySessionSpendRead(previous, sessionSpendReadFromUnknown(payload)),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setState((previous) => applySessionSpendRead(previous, { ok: false }));
      });
    return () => {
      cancelled = true;
    };
  }, [gatewayRequest, status]);

  const spend = useMemo(() => totalUsage(state.sessions), [state.sessions]);
  const basis = useMemo(() => spendCostBasis(state.sessions), [state.sessions]);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.heading}>
          <Text variant="title">Spend</Text>
          <Text variant="caption" color="secondary">
            What this gateway&apos;s sessions have cost, folded from the session catalogue this
            device can read.
          </Text>
        </View>

        {state.loaded ? (
          <Card variant="hero" padding={Spacing.three} style={styles.card}>
            <Text variant="headline">{spendBasisCopy(basis)}</Text>
            <Text variant="caption" color="secondary">
              {spendWindowCopy(state.sessions.length)}
            </Text>
            <Text variant="mono" color="secondary" style={styles.total}>
              {sessionSpendCopy(spend)}
            </Text>
            {state.failed ? (
              <Text variant="caption" color="tertiary">
                Could not re-read spend — showing the last total.
              </Text>
            ) : null}
          </Card>
        ) : state.failed ? (
          <Card variant="surface" padding={Spacing.three} style={styles.card}>
            <Text variant="body" color="secondary">
              {SPEND_UNREAD_COPY}
            </Text>
          </Card>
        ) : (
          <Text variant="caption" color="tertiary">
            {status === 'connected' ? 'Reading spend…' : 'Connect a gateway to read its spend.'}
          </Text>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.four,
    gap: Spacing.three,
  },
  heading: {
    gap: Spacing.one,
  },
  card: {
    gap: Spacing.two,
  },
  total: {
    marginTop: Spacing.one,
  },
});
