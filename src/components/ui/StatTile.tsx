import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { Radius, Spacing } from '@/constants/tokens';

import { Card } from './Card';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export type StatTileProps = {
  label: string;
  value: string;
  sub?: string;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
};

/** Glanceable metric block for dashboards. */
export function StatTile({ label, value, sub, icon, style }: StatTileProps) {
  return (
    <Card variant="inset" padding={Spacing.three} style={[styles.tile, style]}>
      {icon ? <Icon name={icon} size={16} color="accentWarm" /> : null}
      <Text variant="headline" numberOfLines={1}>
        {value}
      </Text>
      <Text variant="micro" color="tertiary" style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {sub ? (
        <Text variant="micro" color="secondary" numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  tile: {
    gap: Spacing.one,
    borderRadius: Radius.lg,
    flex: 1,
    minWidth: 0,
  },
  label: {
    textTransform: 'uppercase',
  },
});
