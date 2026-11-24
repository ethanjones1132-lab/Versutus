import { StyleSheet, Switch, View, type StyleProp, type ViewStyle } from 'react-native';

import { Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import { Skeleton } from './Skeleton';
import { Text } from './Text';

export type SwitchRowProps = {
  /** The row's visible label; also the switch's accessibility label. */
  title: string;
  /** Optional guidance under the title. */
  body?: string;
  /**
   * The controlled value. The row never keeps a copy of its own: the caller
   * owns the state and passes the next one back in.
   */
  value: boolean;
  /** Receives the value the operator asked for; the caller decides whether to apply it. */
  onValueChange: (value: boolean) => void;
  /** Locks the switch while a write is in flight or the setting is unavailable. */
  disabled?: boolean;
  /** The read that backs this setting is still running: show a placeholder, not a switch. */
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * A labelled setting and its switch. One implementation, so the accessible
 * label, the controlled-value contract and the off-track contrast cannot drift
 * from row to row.
 */
export function SwitchRow({ title, body, value, onValueChange, disabled, loading, style }: SwitchRowProps) {
  const tokens = useTokens();

  return (
    <View style={[styles.row, style]}>
      <View style={styles.copy}>
        <Text variant="body">{title}</Text>
        {body ? (
          <Text variant="caption" color="secondary">
            {body}
          </Text>
        ) : null}
      </View>
      {loading ? (
        <View accessible accessibilityRole="progressbar" accessibilityLabel={`${title} is loading`}>
          <Skeleton width={51} height={31} radius={16} />
        </View>
      ) : (
        <Switch
          value={value}
          onValueChange={onValueChange}
          disabled={disabled}
          trackColor={{ true: tokens.accent, false: tokens.controlTrackOff }}
          thumbColor={tokens.textPrimary}
          accessibilityLabel={title}
          accessibilityState={{ checked: value, disabled }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    minHeight: 52,
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: Spacing.one,
  },
});
