import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Spacing } from '@/constants/tokens';
import { haptics } from '@/lib/haptics';

import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type SectionHeaderProps = {
  title: string;
  /** A quiet link on the right ("See all"), when the section has more. */
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * The name of a section on a page: sentence case, tertiary, never the violet
 * capitals the card stacks used. An optional link on the right opens the
 * section's own screen.
 */
export function SectionHeader({ title, actionLabel, onAction, style }: SectionHeaderProps) {
  return (
    <View style={[styles.row, style]}>
      <Text variant="eyebrow" color="tertiary" style={styles.title}>
        {title}
      </Text>
      {actionLabel && onAction ? (
        <PressableScale
          onPress={async () => {
            await haptics.selection();
            onAction();
          }}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`${actionLabel}: ${title}`}>
          <Text variant="caption" color="accent">
            {actionLabel}
          </Text>
        </PressableScale>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingHorizontal: Spacing.one,
    minHeight: 24,
  },
  title: {
    flexShrink: 1,
  },
});
