import { StyleSheet, View } from 'react-native';

import { BotAvatar } from '@/components/chat/bot-avatar';
import { Icon, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { threadStarters, threadWelcomeTitle } from '@/lib/gateway/thread-starters';
import { haptics } from '@/lib/haptics';

/**
 * What an empty, connected thread shows: who you are talking to, one serif
 * question, and three starting points. A starter fills the composer — it
 * never sends — so the operator reads the words before they leave the phone.
 */
export function ThreadWelcome({
  botId,
  botName,
  purpose,
  onPick,
}: {
  /** The Bot this thread talks to; absent in a direct chat. */
  botId?: string;
  botName?: string;
  /** The Bot's one-line purpose, when the Gate reports one. */
  purpose?: string | null;
  onPick: (draft: string) => void;
}) {
  const tokens = useTokens();
  const starters = threadStarters(botId ? 'bot' : 'direct');

  return (
    <View style={styles.root}>
      <View style={styles.hero}>
        {botId ? (
          <BotAvatar botId={botId} name={botName} size={64} />
        ) : (
          <View style={[styles.directTile, { backgroundColor: tokens.accentMuted }]}>
            <Icon name={{ ios: 'sparkles', android: 'auto_awesome', web: 'auto_awesome' }} size={26} color="accent" />
          </View>
        )}
        <Text variant="title" style={styles.title}>
          {threadWelcomeTitle(botName)}
        </Text>
        {purpose ? (
          <Text color="secondary" style={styles.purpose}>
            {purpose}
          </Text>
        ) : null}
      </View>
      <View style={styles.starters}>
        {starters.map((starter) => (
          <PressableScale
            key={starter.label}
            onPress={async () => {
              await haptics.selection();
              onPick(starter.draft);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Start with: ${starter.draft}`}
            style={[styles.starter, { backgroundColor: tokens.backgroundElevated }]}>
            <Text variant="callout" style={styles.starterLabel} numberOfLines={1}>
              {starter.label}
            </Text>
            <Icon
              name={{ ios: 'arrow.up.left', android: 'north_west', web: 'north_west' }}
              size={13}
              color="textTertiary"
            />
          </PressableScale>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
    gap: Spacing.five,
    paddingTop: Spacing.five,
    paddingBottom: Spacing.three,
  },
  hero: {
    alignItems: 'center',
    gap: Spacing.three - 4,
    paddingHorizontal: Spacing.three,
  },
  directTile: {
    width: 64,
    height: 64,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    textAlign: 'center',
    marginTop: Spacing.two,
  },
  purpose: {
    textAlign: 'center',
    maxWidth: 320,
  },
  starters: {
    gap: Spacing.two,
  },
  starter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    minHeight: 48,
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.lg,
  },
  starterLabel: {
    flex: 1,
  },
});
