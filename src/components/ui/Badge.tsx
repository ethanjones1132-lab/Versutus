import { StyleSheet, View } from 'react-native';

import { Palette, Radius, Spacing } from '@/constants/tokens';

import { Text } from './Text';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export type BadgeProps = {
  label: string;
  tone?: BadgeTone;
  /** Show a leading status dot. Default true. */
  dot?: boolean;
  style?: import('react-native').StyleProp<import('react-native').ViewStyle>;
};

const toneStyles: Record<BadgeTone, { backgroundColor: string; borderColor: string; color: string }> = {
  neutral: {
    backgroundColor: Palette.glassHighlight,
    borderColor: Palette.border,
    color: Palette.textSecondary,
  },
  accent: {
    backgroundColor: Palette.accentWarmMuted,
    borderColor: Palette.accentWarmMuted,
    color: Palette.accentWarm,
  },
  success: {
    backgroundColor: Palette.statusConnectedMuted,
    borderColor: Palette.statusConnectedMuted,
    color: Palette.statusConnected,
  },
  warning: {
    backgroundColor: Palette.accentMuted,
    borderColor: Palette.accentMuted,
    color: Palette.statusConnecting,
  },
  danger: {
    backgroundColor: Palette.statusDisconnectedMuted,
    borderColor: Palette.statusDisconnectedMuted,
    color: Palette.statusDisconnected,
  },
};

export function Badge({ label, tone = 'neutral', dot = true, style }: BadgeProps) {
  const colors = toneStyles[tone];

  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: colors.backgroundColor, borderColor: colors.borderColor },
        style,
      ]}>
      {dot ? <View style={[styles.dot, { backgroundColor: colors.color }]} /> : null}
      <Text variant="micro" style={[styles.label, { color: colors.color }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: 3,
    borderRadius: Radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'flex-start',
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  label: {
    textTransform: 'uppercase',
  },
});
