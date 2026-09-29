import { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { BotAvatar } from '@/components/chat/bot-avatar';
import { Icon, PressableScale, Text } from '@/components/ui';
import { Palette, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { useBotCrest } from '@/hooks/use-crest-fleet';
import { threadStarters, threadWelcomeTitle } from '@/lib/gateway/thread-starters';
import { haptics } from '@/lib/haptics';

const HALO = 168;

/**
 * The one still glow on an empty thread: a soft pool of the crest's own light
 * behind it, as if the lamp were turned toward whoever you are about to talk
 * to. A radial gradient rather than a blur, so it renders the same on every
 * platform and costs nothing per frame.
 */
function Halo({ color }: { color: string }) {
  const id = `halo-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <View pointerEvents="none" style={styles.halo}>
      <Svg width={HALO} height={HALO}>
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={color} stopOpacity={0.3} />
            <Stop offset="0.45" stopColor={color} stopOpacity={0.1} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width={HALO} height={HALO} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

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
  const crest = useBotCrest(botId ?? '', botName);
  const glow = botId ? crest.tone.from : Palette.accent;

  return (
    <View style={styles.root}>
      <View style={styles.hero}>
        <View style={styles.mark}>
          <Halo color={glow} />
          {botId ? (
            <BotAvatar botId={botId} name={botName} size={64} wake />
          ) : (
            <View style={[styles.directTile, { backgroundColor: tokens.accentMuted }]}>
              <Icon name={{ ios: 'sparkles', android: 'auto_awesome', web: 'auto_awesome' }} size={26} color="accent" />
            </View>
          )}
        </View>
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
            style={[
              styles.starter,
              { backgroundColor: tokens.backgroundElevated, borderTopColor: tokens.specular },
            ]}>
            <Text variant="callout" color="secondary" numberOfLines={1}>
              {starter.label}
            </Text>
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
  mark: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  halo: {
    position: 'absolute',
    width: HALO,
    height: HALO,
    left: (64 - HALO) / 2,
    top: (64 - HALO) / 2,
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
  // Suggestions, not a menu: short pills set centred and allowed to wrap,
  // so they sit under the question like replies you might give.
  starters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
  },
  starter: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.full,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
