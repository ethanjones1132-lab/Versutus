import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { haptics } from '@/lib/haptics';

import { GlassSurface } from './GlassSurface';
import { Icon, type IconName } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type ListRowProps = {
  title: string;
  subtitle?: string;
  /** Leading glyph; rendered inside a chip halo. */
  icon?: IconName;
  /** Leading status dot color (semantic key or raw). Overrides icon halo when set. */
  statusColor?: string;
  /** Fully custom leading element (e.g. a generated avatar). Overrides icon/statusColor when set. */
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onPress?: () => void;
  /** Show a trailing chevron. Default true when onPress is set. */
  chevron?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** Compact settings/list row with optional leading glyph and trailing accessory. */
export function ListRow({
  title,
  subtitle,
  icon,
  statusColor,
  leading,
  trailing,
  onPress,
  chevron,
  style,
}: ListRowProps) {
  const tokens = useTokens();
  const showChevron = chevron ?? !!onPress;

  const handlePress = async () => {
    await haptics.selection();
    onPress?.();
  };

  return (
    <PressableScale
      onPress={onPress ? handlePress : undefined}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      style={[styles.row, style]}>
      {leading ? (
        leading
      ) : statusColor ? (
        <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
      ) : icon ? (
        <GlassSurface variant="chip" radius={Radius.full} padding={0} style={styles.iconHalo}>
          <Icon name={icon} size={16} color="accentWarm" />
        </GlassSurface>
      ) : null}
      <View style={styles.titles}>
        <Text variant="body" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" color="secondary" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {showChevron ? (
        <Icon
          name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
          size={14}
          color={tokens.textTertiary}
        />
      ) : null}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 4,
    paddingVertical: Spacing.two + 2,
    paddingHorizontal: Spacing.two,
    minHeight: 48,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginHorizontal: Spacing.two,
  },
  iconHalo: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titles: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
});
