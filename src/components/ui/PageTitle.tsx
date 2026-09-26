import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Spacing } from '@/constants/tokens';

import { Text } from './Text';

export type PageTitleProps = {
  title: string;
  /** The control row above the title: a menu or back button, trailing actions. */
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  /** One quiet line under the title — usually a status. */
  status?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * A top-level page's large title: the controls on their own quiet row, then
 * the page's name in the serif, then at most one line of status. It is the
 * roster's greeting pattern applied to every destination, so Activity, Tools
 * and the Gate open the same way Chat does.
 */
export function PageTitle({ title, leading, trailing, status, style }: PageTitleProps) {
  return (
    <View style={[styles.root, style]}>
      {leading || trailing ? (
        <View style={styles.controls}>
          <View style={styles.side}>{leading}</View>
          <View style={[styles.side, styles.trailing]}>{trailing}</View>
        </View>
      ) : null}
      <View style={styles.titles}>
        <Text variant="display" numberOfLines={1}>
          {title}
        </Text>
        {status ? <View style={styles.status}>{status}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: Spacing.three,
    paddingBottom: Spacing.two,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 40,
    marginHorizontal: -Spacing.two,
  },
  side: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  trailing: {
    justifyContent: 'flex-end',
  },
  titles: {
    gap: Spacing.two,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
});
