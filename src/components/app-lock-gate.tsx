// ─── The opt-in app lock's gate ────────────────────────────────────
// Wraps the Stack inside AppBootstrap (FUTURE-ITEMS §P4). The cover is drawn
// OVER the app rather than replacing it: the router, the deep-link listener and
// the notification router all keep running while the lock is up, so a tap or a
// link that arrives mid-lock is handled exactly as it always is.
//
// It only ever covers a device that can answer the biometric prompt — see
// app-lock.ts for why a removed enrollment must unlock rather than trap the
// operator. Nothing here reaches a gateway: the lock is a device preference.

import * as LocalAuthentication from 'expo-local-authentication';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';

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

export function AppLockGate({ children }: { children: React.ReactNode }) {
  const tokens = useTokens();
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
      {locked ? (
        <View style={[styles.cover, { backgroundColor: tokens.background }]}>
          <VersutusMark size={64} />
          <Text variant="headline">{APP_LOCK_COVER_TITLE}</Text>
          <Text variant="caption" color="secondary" style={styles.body}>
            {APP_LOCK_COVER_BODY}
          </Text>
          <Button label={APP_LOCK_UNLOCK_LABEL} onPress={() => void unlock()} />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  cover: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Above the connected toast (zIndex 999) and level with the splash overlay
    // that shares this host, which renders earlier: a gateway name on screen
    // while the app is locked is exactly the leak the lock is for.
    zIndex: 1000,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.five,
  },
  body: {
    textAlign: 'center',
  },
});
