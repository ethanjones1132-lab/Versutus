import { Button as SwiftButton, ContentUnavailableView, Host } from '@expo/ui/swift-ui';
import { StyleSheet, View } from 'react-native';

import {
  CHAT_EMPTY_FAILED_COPY,
  CHAT_EMPTY_PENDING_COPY,
  useChatEmptyConnect,
} from '@/components/chat/chat-empty-connect';
import { Button } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

/**
 * The iOS empty chat. It mirrors the shared empty's promise-owned press: the
 * pending line appears the moment the control is tapped, and a press whose
 * promise settles with no gateway becomes the failed state with Try again and
 * the PC address — while the automatic cycle still only holds it pending.
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
  // The press says so at once; the screen's own searching/connecting line takes
  // back over as soon as the cycle provides one.
  const shownDescription = failed
    ? CHAT_EMPTY_FAILED_COPY
    : pressing && !attempting
      ? CHAT_EMPTY_PENDING_COPY
      : description;

  return (
    <View style={styles.fallback}>
      <Host style={styles.host}>
        <ContentUnavailableView
          title={title}
          description={shownDescription}
          systemImage="bubble.left.and.bubble.right"
        />
      </Host>
      {failed ? (
        <>
          <Button label="Try again" onPress={onConnect} />
          {onSetup ? <Button label="Set up PC address" onPress={onSetup} /> : null}
        </>
      ) : (
        <Button label="Connect to gateway" onPress={onConnect} />
      )}
      <SwiftButton label="Go to Home" onPress={onGoHome} />
      {onSettings ? <Button label="Settings" variant="ghost" onPress={onSettings} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    padding: Spacing.four,
  },
  host: {
    minHeight: 180,
    alignSelf: 'stretch',
  },
});
