// ─── The crash screen ─────────────────────────────────────────────────────
// What a thrown render error gets instead of a redbox. On a release build there
// is no redbox at all, so without this the app simply stops: a blank stage with
// nothing on it and no way to say what happened. The screen names the failure,
// offers the one action that can still help (retry, which clears the error and
// re-renders), and puts the message and stack on the clipboard so the operator
// can carry them out by hand — the log on Diagnostics is what stays behind.

import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Screen, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

export type ErrorFallbackProps = {
  error: Error;
  retry: () => void;
};

export function ErrorFallback({ error, retry }: ErrorFallbackProps) {
  const [copied, setCopied] = useState(false);

  const copyDetails = async () => {
    const details = [error?.message, error?.stack].filter(Boolean).join('\n\n');
    try {
      await Clipboard.setStringAsync(details);
      setCopied(true);
    } catch {
      // A refused clipboard must not turn the crash screen into a second crash.
    }
  };

  return (
    <Screen>
      <View style={styles.root}>
        <Text variant="title">Something went wrong</Text>
        <Text variant="body" color="secondary" style={styles.message} selectable>
          {error?.message ?? 'An unknown error stopped this screen.'}
        </Text>
        <Text variant="caption" color="tertiary">
          {copied
            ? 'Copied. Diagnostics keeps the last 50 failures on this phone.'
            : 'The failure is recorded under Settings → Diagnostics.'}
        </Text>
        <Button label="Try again" onPress={retry} style={styles.action} />
        <Button
          label="Copy details"
          variant="secondary"
          onPress={() => void copyDetails()}
          style={styles.action}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'center',
    gap: Spacing.two,
    padding: Spacing.four,
  },
  message: {
    marginTop: Spacing.one,
  },
  action: {
    marginTop: Spacing.two,
  },
});
