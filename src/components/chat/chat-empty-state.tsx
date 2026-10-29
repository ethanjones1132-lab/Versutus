import { StyleSheet, View } from 'react-native';

import { VersutusMark } from '@/components/brand/versutus-mark';
import {
  CHAT_EMPTY_FAILED_COPY,
  CHAT_EMPTY_PENDING_COPY,
  useChatEmptyConnect,
} from '@/components/chat/chat-empty-connect';
import { Button, Text } from '@/components/ui';
import { Palette, Radius, Spacing } from '@/constants/tokens';

/**
 * The first thing a phone with no live Gate shows: the mark, one serif line
 * saying where things stand, the reason in plain words, and one clear way
 * forward. The two quieter doors (the Gate, Settings) sit side by side under
 * it instead of stacking three full-width buttons.
 *
 * The press is the attempt: it shows its own pending line at once and, when the
 * promise it started settles with no gateway, becomes the failed state that
 * offers Try again and the PC address. `attempting` is the screen's automatic
 * cycle and only ever adds pending; it never ends a press.
 */
export function ChatEmptyState({
  title,
  description,
  onConnect: requestConnect,
  onGoHome,
  onSettings,
  onSetup,
  attempting,
}: {
  title: string;
  description: string;
  onConnect: () => void | Promise<unknown>;
  onGoHome: () => void;
  /** Optional settings door so this empty never forces a Home detour. */
  onSettings?: () => void;
  /** Optional setup door the failed attempt offers beside Try again. */
  onSetup?: () => void;
  /** The screen's own automatic cycle; secondary to the press's promise. */
  attempting?: boolean;
}) {
  const { pressing, failed, start: onConnect } = useChatEmptyConnect({
    onConnect: requestConnect,
    attempting,
  });
  // The press says so at once, before any phase shows. Once the screen's own
  // searching/connecting description arrives, that more specific line keeps
  // the hero; the press only ever adds words while it has none.
  const shownDescription = failed
    ? CHAT_EMPTY_FAILED_COPY
    : pressing && !attempting
      ? CHAT_EMPTY_PENDING_COPY
      : description;

  return (
    <View style={styles.fallback}>
      <View style={styles.hero}>
        <View style={styles.markHalo}>
          <VersutusMark size={64} />
        </View>
        <Text variant="display" style={styles.title}>
          {title}
        </Text>
        <View style={styles.rule} />
        <Text color="secondary" style={styles.description}>
          {shownDescription}
        </Text>
      </View>
      <View style={styles.actions}>
        {failed ? (
          <>
            <Button label="Try again" onPress={onConnect} />
            {onSetup ? (
              <Button label="Set up PC address" variant="secondary" onPress={onSetup} />
            ) : null}
          </>
        ) : (
          <Button label="Connect to gateway" onPress={onConnect} />
        )}
        <View style={styles.secondary}>
          <Button label="Go to Home" variant="ghost" onPress={onGoHome} />
          {onSettings ? <Button label="Settings" variant="ghost" onPress={onSettings} /> : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    flex: 1,
    justifyContent: 'center',
    gap: Spacing.five,
    padding: Spacing.four,
    maxWidth: 460,
    width: '100%',
    alignSelf: 'center',
  },
  hero: {
    alignItems: 'center',
    gap: Spacing.three,
  },
  // The mark sits in a still pool of its own light — the one glow on this
  // screen — lifted off the stage by a soft violet shadow.
  markHalo: {
    borderRadius: Radius.xl,
    boxShadow: '0 16px 48px rgba(139,124,255,0.35)',
    marginBottom: Spacing.two,
  },
  title: {
    textAlign: 'center',
  },
  // A short violet rule under the title: the brand's one accent here.
  rule: {
    width: 32,
    height: 2,
    borderRadius: Radius.full,
    backgroundColor: Palette.accent,
    borderColor: Palette.borderStrong,
  },
  description: {
    textAlign: 'center',
    lineHeight: 23,
    maxWidth: 320,
  },
  actions: {
    gap: Spacing.two,
  },
  secondary: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.two,
  },
});
