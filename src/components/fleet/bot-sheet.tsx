import { StyleSheet, View } from 'react-native';

import { BaseSheet, Button, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import type { BotSheetView } from '@/lib/fleet/bot-sheet';

export type FleetBotSheetProps = {
  /** The folded view-model; null renders nothing (sheet dismissed). */
  view: BotSheetView | null;
  onClose: () => void;
  /** Opens the Bot's Chat — the route owns the navigation and the gate. */
  onOpenChat?: () => void;
};

/**
 * The Bot star's detail surface: the full name a packed ~50px label cannot
 * hold, what it is running, its routine health and its pending approvals —
 * straight from the pure view-model, nothing re-worded. A credential has no
 * place here and no line here names one; the tap still owns Chat, this only
 * reads the star out loud.
 */
export function FleetBotSheet({ view, onClose, onOpenChat }: FleetBotSheetProps) {
  if (!view) return null;
  return (
    <BaseSheet visible eyebrow="BOT" title={view.name} onClose={onClose} closeLabel="Dismiss">
      <View style={styles.body}>
        {view.description ? (
          <Text variant="body" color="secondary">
            {view.description}
          </Text>
        ) : null}
        {view.id ? (
          <View>
            <Text variant="micro" color="tertiary">
              PROFILE ID
            </Text>
            <Text variant="mono">{view.id}</Text>
          </View>
        ) : null}
        {view.running ? (
          <View>
            <Text variant="micro" color="tertiary">
              RUNNING NOW
            </Text>
            <Text variant="body">{view.running}</Text>
          </View>
        ) : null}
        {view.routine ? (
          <View>
            <Text variant="micro" color="tertiary">
              ROUTINES
            </Text>
            <Text variant="body">{view.routine}</Text>
          </View>
        ) : null}
        {view.approvals ? (
          <View>
            <Text variant="micro" color="tertiary">
              WAITING
            </Text>
            <Text variant="body">{view.approvals}</Text>
          </View>
        ) : null}
        {onOpenChat ? (
          <Button label="Open Chat" size="sm" onPress={onOpenChat} />
        ) : null}
      </View>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: Spacing.three,
    paddingBottom: Spacing.two,
  },
});
