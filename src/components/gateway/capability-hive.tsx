import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Text } from '@/components/ui';
import { Palette, Spacing, type SemanticPalette } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { GatewayCapabilityGroup, GatewayCapabilitySnapshot } from '@/lib/gateway/types';

/**
 * Compact "capability hive" micro-visualization for the dashboard. Each cell is
 * one capability group as a diamond; colour carries readiness at a glance and
 * in-flight groups pulse. This is the glance layer — the full GatewayCapabilities
 * card below it carries the detail.
 */
export function CapabilityHive({
  groups,
  status,
}: {
  groups: GatewayCapabilityGroup[];
  status: GatewayCapabilitySnapshot['status'];
}) {
  const tokens = useTokens();
  const [selected, setSelected] = useState<string | null>(null);
  const ready = groups.filter((group) => group.status === 'ready' || group.status === 'available').length;
  const selectedGroup = selected ? groups.find((group) => group.id === selected) : undefined;
  const showBusy = status === 'warming' || status === 'partial';

  return (
    <View style={styles.wrap}>
      <View style={styles.grid}>
        {groups.map((group, index) => (
          <HiveCell
            key={group.id}
            group={group}
            index={index}
            tokens={tokens}
            selected={selected === group.id}
            busy={showBusy}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setSelected((current) => (current === group.id ? null : group.id));
            }}
          />
        ))}
      </View>
      <View style={styles.summary}>
        <Text variant="micro" color="accentWarm">
          {ready}/{groups.length} ready
        </Text>
        <Text variant="micro" color="tertiary" numberOfLines={1} style={styles.detail}>
          {selectedGroup ? selectedGroup.label : status}
        </Text>
      </View>
    </View>
  );
}

function HiveCell({
  group,
  index,
  tokens,
  selected,
  busy,
  onPress,
}: {
  group: GatewayCapabilityGroup;
  index: number;
  tokens: SemanticPalette;
  selected: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const pulse = useSharedValue(1);
  const active = group.status === 'warming' || group.status === 'stale' || busy;

  useEffect(() => {
    if (active) {
      pulse.value = withRepeat(withTiming(1.5, { duration: 900 }), -1, true);
      return () => cancelAnimation(pulse);
    }
    pulse.value = withTiming(1, { duration: 200 });
  }, [active, pulse]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: '45deg' }, { scale: pulse.value }],
  }));

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${group.label} — ${group.status}`}
      style={styles.cellPress}
      hitSlop={4}>
      <Animated.View
        entering={FadeIn.delay(index * 28).duration(280)}
        style={[
          styles.cell,
          { backgroundColor: hiveColor(group.status, tokens) },
          selected && styles.cellSelected,
          animatedStyle,
        ]}
      />
    </Pressable>
  );
}

function hiveColor(status: GatewayCapabilityGroup['status'], tokens: SemanticPalette): string {
  switch (status) {
    case 'ready':
    case 'available':
      return tokens.statusConnected;
    case 'warming':
    case 'stale':
      return tokens.statusConnecting;
    case 'missing-scope':
    case 'unsupported':
    case 'unhealthy':
    case 'partial':
      return tokens.statusDisconnected;
    case 'experimental':
      return tokens.accent;
    default:
      return tokens.textTertiary;
  }
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
    maxWidth: '62%',
  },
  cellPress: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cell: {
    width: 9,
    height: 9,
    opacity: 0.9,
  },
  cellSelected: {
    opacity: 1,
    width: 11,
    height: 11,
    borderColor: Palette.accentWarm,
    borderWidth: 1,
  },
  summary: {
    alignItems: 'flex-end',
    gap: Spacing.half,
    flexShrink: 1,
  },
  detail: {
    maxWidth: 120,
  },
});
