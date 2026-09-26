import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { haptics } from '@/lib/haptics';

import { Icon, type IconName } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type DisclosureRowProps = {
  label: string;
  /** Whether the section this row opens is open. Announced and drawn as the chevron. */
  expanded: boolean;
  onPress: () => void;
  /** Glyph for the section, set in the same small tile a ListRow uses. */
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
};

/**
 * The head of a collapsible section: its name on the left and a chevron that
 * turns as the section opens. It is a row, not a centred text button, so a
 * stack of sections (a Bot's skills, tools and routines) reads as a list.
 */
export function DisclosureRow({ label, expanded, onPress, icon, style }: DisclosureRowProps) {
  const tokens = useTokens();
  return (
    <PressableScale
      onPress={async () => {
        await haptics.selection();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded }}
      style={[styles.row, { backgroundColor: tokens.backgroundInset }, style]}>
      {icon ? (
        <View style={[styles.tile, { backgroundColor: tokens.backgroundRaised }]}>
          <Icon name={icon} size={15} color="accent" />
        </View>
      ) : null}
      <Text variant="callout" style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <Icon
        name={
          expanded
            ? { ios: 'chevron.up', android: 'expand_less', web: 'expand_less' }
            : { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }
        }
        size={16}
        color="textTertiary"
      />
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 4,
    minHeight: 52,
    paddingHorizontal: Spacing.three - 2,
    borderRadius: Radius.lg,
  },
  tile: {
    width: 30,
    height: 30,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    flex: 1,
  },
});
