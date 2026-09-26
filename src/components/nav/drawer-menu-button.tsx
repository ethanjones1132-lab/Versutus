import { useNavigation } from 'expo-router';
import { StyleSheet } from 'react-native';

import { Icon, PressableScale } from '@/components/ui';

type DrawerMenuButtonProps = {
  /** Override accessibility label when the control is not the generic menu. */
  accessibilityLabel?: string;
};

/**
 * Leading control that opens the side drawer. Dispatches the drawer router's
 * OPEN_DRAWER action so it works from any screen nested under the drawer
 * layout without importing expo-router internals.
 */
export function DrawerMenuButton({
  accessibilityLabel = 'Open navigation menu',
}: DrawerMenuButtonProps) {
  const navigation = useNavigation();

  return (
    <PressableScale
      onPress={() => navigation.dispatch({ type: 'OPEN_DRAWER' })}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={styles.hit}>
      <Icon
        name={{ ios: 'line.3.horizontal', android: 'menu', web: 'menu' }}
        size={18}
        color="textSecondary"
      />
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  hit: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
