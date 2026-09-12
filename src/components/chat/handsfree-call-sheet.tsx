import { ScrollView, StyleSheet, View } from 'react-native';

import { BaseSheet, Button, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import {
  HANDSFREE_BANNER_TITLE,
  HANDSFREE_DISCLOSURE,
} from '@/lib/voice/handsfree-call-copy';
import { haptics } from '@/lib/haptics';

/**
 * The disclosure a call shows before it starts — the first one and every one
 * after. The words are the contract: speech leaves automatically once the call
 * is live, the call survives backgrounding, and it can be ended from Android's
 * notification. Nothing here starts a call by itself; `Start call` is the one
 * tap that does, and Cancel starts nothing.
 */
export function HandsfreeCallSheet({
  visible,
  label,
  busy,
  error,
  onCancel,
  onStart,
}: {
  visible: boolean;
  label?: string;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onStart: () => void;
}) {
  if (!visible) return null;

  return (
    <BaseSheet
      visible={visible}
      eyebrow="HANDS-FREE CALL"
      onClose={onCancel}
      closeLabel="Cancel"
      position="bottom">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}>
        <Text variant="title">
          {label ? `Start a hands-free call with ${label}?` : `Start a ${HANDSFREE_BANNER_TITLE}?`}
        </Text>

        <Text color="secondary" style={styles.disclosure}>
          {HANDSFREE_DISCLOSURE}
        </Text>

        {error ? (
          <Text variant="caption" color="statusDisconnected" style={styles.error}>
            {error}
          </Text>
        ) : null}

        <View style={styles.footer}>
          <Button
            label="Cancel"
            variant="secondary"
            onPress={async () => {
              await haptics.light();
              onCancel();
            }}
            disabled={busy}
            style={styles.footerButton}
          />
          <Button
            label="Start call"
            onPress={async () => {
              await haptics.success();
              onStart();
            }}
            busy={busy}
            disabled={busy}
            style={styles.footerPrimary}
          />
        </View>
      </ScrollView>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  scroll: {
    gap: Spacing.two,
    paddingBottom: Spacing.two,
  },
  disclosure: {
    marginTop: Spacing.two,
    lineHeight: 20,
  },
  error: {
    marginTop: Spacing.two,
  },
  footer: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingTop: Spacing.three,
    marginTop: Spacing.two,
  },
  footerButton: {
    flex: 1,
  },
  footerPrimary: {
    flex: 2,
  },
});
