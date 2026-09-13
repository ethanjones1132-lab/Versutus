import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

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
 *
 * When an engine is chosen, the sheet names it and shows that engine's own
 * disclosure, so consent matches where the audio actually goes. `Change` is a
 * one-tap change for this call only.
 */
export function HandsfreeCallSheet({
  visible,
  label,
  busy,
  error,
  engineLabel,
  disclosure,
  onChangeEngine,
  onCancel,
  onStart,
}: {
  visible: boolean;
  label?: string;
  busy?: boolean;
  error?: string;
  engineLabel?: string;
  disclosure?: string;
  onChangeEngine?: () => void;
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

        {engineLabel ? (
          <View style={styles.engineLine}>
            <Text variant="caption" color="secondary">
              Using: {engineLabel}
            </Text>
            {onChangeEngine ? (
              <Pressable accessibilityRole="button" onPress={onChangeEngine}>
                <Text variant="link" color="accent">
                  Change
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <Text color="secondary" style={styles.disclosure}>
          {disclosure ?? HANDSFREE_DISCLOSURE}
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
  engineLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    marginTop: Spacing.two,
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
