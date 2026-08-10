import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Palette, Spacing } from '@/constants/tokens';

export type DividerProps = {
  /** Left inset (e.g. to clear a leading icon in a list row). */
  inset?: number;
  style?: StyleProp<ViewStyle>;
};

export function Divider({ inset = 0, style }: DividerProps) {
  return <View style={[styles.rule, { marginLeft: inset }, style]} />;
}

const styles = StyleSheet.create({
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Palette.borderSubtle,
    marginVertical: Spacing.one,
  },
});
