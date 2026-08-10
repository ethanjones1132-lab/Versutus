import { StyleSheet } from 'react-native';

import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { haptics } from '@/lib/haptics';

import { Icon, type IconName } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type ChipProps = {
  label: string;
  onPress?: () => void;
  selected?: boolean;
  icon?: IconName;
  disabled?: boolean;
  style?: import('react-native').StyleProp<import('react-native').ViewStyle>;
};

/** Dense interactive pill — quick actions, filters, model/session shortcuts. */
export function Chip({ label, onPress, selected = false, icon, disabled, style }: ChipProps) {
  const tokens = useTokens();

  const handlePress = async () => {
    await haptics.selection();
    onPress?.();
  };

  return (
    <PressableScale
      onPress={onPress ? handlePress : undefined}
      disabled={disabled || !onPress}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: !!disabled }}
      accessibilityLabel={label}
      style={[
        styles.chip,
        {
          backgroundColor: selected ? tokens.accentMuted : tokens.glassHighlight,
          borderColor: selected ? tokens.accentWarm : tokens.border,
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}>
      {icon ? (
        <Icon name={icon} size={14} color={selected ? 'accentWarm' : 'textSecondary'} />
      ) : null}
      <Text variant="caption" color={selected ? 'accentWarm' : 'secondary'} numberOfLines={1}>
        {label}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three - 4,
    paddingVertical: Spacing.one + 2,
    borderRadius: Radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'flex-start',
  },
});
