// ─── The opt-in app lock's gate ────────────────────────────────────
// Wraps the Stack inside AppBootstrap (FUTURE-ITEMS §P4). The cover is drawn
// OVER the app rather than replacing it: the router, the deep-link listener and
// the notification router all keep running while the lock is up, so a tap or a
// link that arrives mid-lock is handled exactly as it always is.
//
// The cover is a Modal — the surface a sheet is presented in (BaseSheet) —
// because a View sitting beside the Stack is not above one: an open sheet and a
// modal-presentation route are drawn by a native presenter, and only a later
// Modal outranks them. The lock also brings the Stack's presented routes down,
// so a modal route the operator left open is not waiting under the cover for
// the unlock to reveal it — and neither is one that arrives AFTER the lock,
// which is the worse case: react-native-screens presents a stack modal FROM the
// topmost presented controller, and while this cover is up that controller is
// the cover itself, so an arriving route is presented above it unless it comes
// down too.
//
// It only ever covers a device that can answer the biometric prompt — see
// app-lock.ts for why a removed enrollment must unlock rather than trap the
// operator. Nothing here reaches a gateway: the lock is a device preference.

import * as LocalAuthentication from 'expo-local-authentication';
import { usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Modal, StyleSheet, View } from 'react-native';

import { VersutusMark } from '@/components/brand/versutus-mark';
import { Button, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import {
  APP_LOCK_COVER_BODY,
  APP_LOCK_COVER_TITLE,
  APP_LOCK_UNLOCK_LABEL,
} from '@/lib/settings/app-lock';
import { deviceAppLockState } from '@/lib/settings/app-lock-device';

/** Modal asks Android for a back handler; the lock is not dismissable. */
const ignoreBackPress = () => undefined;

export function AppLockGate({ children }: { children: React.ReactNode }) {
  const tokens = useTokens();
  const router = useRouter();
  // The presented route. Reading it is what arms the dismissal below for a
  // route the lock has not seen yet: the Stack's route list moving is the edge
  // a `versutus://add` link landing on a locked app produces.
  const presentedRoute = usePathname();
  const [locked, setLocked] = useState(false);
  // The read settles once; the background listener below needs the answer
  // without re-asking the device on every app-state change.
  const lockableRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const state = await deviceAppLockState();
      if (cancelled) return;
      const lockable = state.enabled && state.reason === null;
      lockableRef.current = lockable;
      setLocked(lockable);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Leaving the app locks it again: a cover that only appeared at launch would
  // leave the app readable in the switcher. 'background' and not 'inactive': a
  // system prompt over the app reports 'inactive', and relocking on that risks
  // dropping a second cover the moment the operator unlocks, so the gate takes
  // the one edge that only a real leave produces.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background' && lockableRef.current) setLocked(true);
    });
    return () => subscription.remove();
  }, []);

  // The lock, and only the lock, brings the presented routes down: the lock
  // edge, and any route that arrives while it is up. Being a Modal puts the
  // cover above a sheet; a modal route is a screen this tree does not own, so
  // it is dismissed rather than covered — the Stack itself stays mounted and
  // the operator lands on its first screen. The route is read along with the
  // lock so that a route the lock never saw brings itself down rather than
  // sitting above the cover. Dismissing is skipped when there is nothing to
  // pop, and the unlock path never navigates.
  useEffect(() => {
    if (!locked) return;
    if (!router.canDismiss()) return;
    router.dismissAll();
  }, [locked, router, presentedRoute]);

  const unlock = useCallback(async () => {
    try {
      // The device's own passcode stays a fallback (the module's default), so
      // a failed biometric is a retry here, not a way to lose the app.
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: APP_LOCK_UNLOCK_LABEL,
      });
      if (result.success) setLocked(false);
    } catch {
      // A prompt that could not run leaves the cover up; Unlock is the retry.
    }
  }, []);

  return (
    <>
      {children}
      <Modal
        visible={locked}
        transparent
        // No animation: a fade would leave the app legible under the cover for
        // the length of the fade, which is the leak the lock is for.
        animationType="none"
        onRequestClose={ignoreBackPress}
        statusBarTranslucent>
        <View style={[styles.cover, { backgroundColor: tokens.background }]}>
          <VersutusMark size={64} />
          <Text variant="headline">{APP_LOCK_COVER_TITLE}</Text>
          <Text variant="caption" color="secondary" style={styles.body}>
            {APP_LOCK_COVER_BODY}
          </Text>
          <Button label={APP_LOCK_UNLOCK_LABEL} onPress={() => void unlock()} />
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  cover: {
    // Being the Modal's own content — presented after a sheet, over the
    // Stack's native screens — is what puts this on top; there is no second
    // mechanism beside it, and nothing under it is legible or tappable.
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.five,
  },
  body: {
    textAlign: 'center',
  },
});
