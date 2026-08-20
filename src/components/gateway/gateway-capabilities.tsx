import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { Palette, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { GatewayCapabilitySnapshot, GatewayCapabilityGroup } from '@/lib/gateway/types';

export function GatewayCapabilities({ snapshot }: { snapshot: GatewayCapabilitySnapshot }) {
  const { groups, checkedAt, status: snapStatus } = snapshot;
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

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
  const staleMinutes = Math.max(0, Math.floor((now - checkedAt) / 60000));

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <View style={styles.header}>
        <Text variant="caption" style={styles.onGlassPrimary}>Gateway capabilities</Text>
        <View style={{ alignItems: 'flex-end' }}>
          <Text variant="caption" style={styles.onGlassSecondary}>
            {readyGroups.length}/{counted.length} ready
          </Text>
          <Text variant="caption" color="tertiary" style={{ fontSize: 10 }}>
            {snapStatus} • {staleMinutes}m ago
          </Text>
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
          accessibilityLabel={showAll ? 'Hide unsupported capabilities' : 'Show all capabilities'}>
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
