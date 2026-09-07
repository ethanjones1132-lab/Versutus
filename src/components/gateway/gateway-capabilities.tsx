import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { Palette, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { useNow } from '@/hooks/use-now';
import type { GatewayCapabilitySnapshot, GatewayCapabilityGroup } from '@/lib/gateway/types';

export function GatewayCapabilities({ snapshot }: { snapshot: GatewayCapabilitySnapshot }) {
  const { groups, checkedAt, status: snapStatus } = snapshot;
  const [showAll, setShowAll] = useState(false);

  // Undeclared groups exist in no gateway this app knows; they are not
  // capabilities the connected one lacks, so they stay out of the ratio.
  const counted = useMemo(() => groups.filter((group) => group.status !== 'undeclared'), [groups]);
  const readyGroups = useMemo(
    () => counted.filter((group) => group.status === 'ready' || group.status === 'available'),
    [counted],
  );
  const otherGroups = useMemo(
    () => groups.filter((group) => group.status !== 'ready' && group.status !== 'available'),
    [groups],
  );
  const visible = showAll ? groups : readyGroups.length > 0 ? readyGroups : groups.slice(0, 6);
  const hiddenCount = Math.max(0, groups.length - visible.length);

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <View style={styles.header}>
        <Text variant="caption" style={styles.onGlassPrimary}>Gateway capabilities</Text>
        <View style={{ alignItems: 'flex-end' }}>
          <Text variant="caption" style={styles.onGlassSecondary}>
            {readyGroups.length}/{counted.length} ready
          </Text>
          <CapabilityFreshness checkedAt={checkedAt} status={snapStatus} />
        </View>
      </View>
      <View style={styles.grid}>
        {visible.map((group) => (
          <CapabilityPill key={group.id} group={group} />
        ))}
      </View>
      {otherGroups.length > 0 ? (
        <Pressable
          onPress={() => setShowAll((value) => !value)}
          accessibilityRole="button"
          accessibilityLabel={showAll ? 'Hide unsupported capabilities' : 'Show all capabilities'}
          accessibilityState={{ expanded: showAll }}>
          <Text variant="caption" color="accentWarm" style={styles.toggle}>
            {showAll
              ? 'Hide unsupported'
              : hiddenCount > 0
                ? `Show ${hiddenCount} not offered`
                : 'Show unsupported'}
          </Text>
        </Pressable>
      ) : null}
    </Card>
  );
}

/**
 * The "Xm ago" freshness stamp. Owns its own per-minute tick so the rest of
 * the card — every CapabilityPill, the header, the show-all toggle — stays
 * still between checks. A frozen stamp would itself be misleading, but
 * re-rendering the whole pill grid once a minute just to advance the clock
 * repainted every capability for a single number.
 */
function CapabilityFreshness({ checkedAt, status }: { checkedAt: number; status: string }) {
  const now = useNow(60_000, true);
  const staleMinutes = Math.max(0, Math.floor((now - checkedAt) / 60000));
  return (
    <Text variant="micro" color="tertiary">
      {status} • {staleMinutes}m ago
    </Text>
  );
}

function CapabilityPill({ group }: { group: GatewayCapabilityGroup }) {
  const tokens = useTokens();
  const status = (group.status as string) || 'unknown';

  const color =
    status === 'ready'
      ? tokens.accentWarm
      : status === 'warming' || status === 'stale'
        ? tokens.statusConnecting
        : status === 'missing-scope' || status === 'unsupported'
          ? tokens.statusDisconnected
          : status === 'experimental'
            ? tokens.accent
            : tokens.textTertiary;

  const labelText =
    status === 'ready'
      ? `${group.availableCount || 0}/${group.totalCount || 1}`
      : group.note || status.replace('-', ' ');

  return (
    <View style={[styles.pill, { borderColor: tokens.glassBorder, backgroundColor: tokens.backgroundInset }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <View style={styles.pillText}>
        <Text variant="caption" numberOfLines={1}>
          {group.label}
        </Text>
        <Text variant="caption" color="tertiary" numberOfLines={1}>
          {labelText}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.md,
    gap: Spacing.two,
    borderColor: Palette.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  toggle: {
    alignSelf: 'flex-start',
    marginTop: Spacing.one,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  pill: {
    minHeight: 36,
    maxWidth: 140,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.one,
    paddingVertical: Spacing.half,
    borderRadius: Radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  pillText: {
    minWidth: 0,
  },
  onGlassPrimary: {
    color: Palette.textPrimary,
  },
  onGlassSecondary: {
    color: Palette.textSecondary,
  },
});
