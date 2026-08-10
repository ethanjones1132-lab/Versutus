import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Radius, Spacing } from '@/constants/tokens';

import { Button } from './Button';
import { GlassSurface } from './GlassSurface';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export type EmptyStateProps = {
  icon: IconName;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
};

/** Friendly empty surface: glyph, title, guidance, optional action. */
export function EmptyState({ icon, title, description, actionLabel, onAction, style }: EmptyStateProps) {
  return (
    <View style={[styles.root, style]}>
      <GlassSurface variant="chip" radius={Radius.full} padding={0} style={styles.iconHalo}>
        <Icon name={icon} size={26} color="accentWarm" />
      </GlassSurface>
      <Text variant="headline" style={styles.title}>
        {title}
      </Text>
      {description ? (
        <Text variant="caption" color="secondary" style={styles.description}>
          {description}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <Button label={actionLabel} variant="secondary" size="sm" onPress={onAction} style={styles.action} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.five,
    paddingHorizontal: Spacing.four,
  },
  iconHalo: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.one,
  },
  title: {
    textAlign: 'center',
  },
  description: {
    textAlign: 'center',
    maxWidth: 320,
  },
  action: {
    marginTop: Spacing.two,
  },
});
