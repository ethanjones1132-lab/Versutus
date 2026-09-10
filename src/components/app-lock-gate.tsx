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
// A route the lock brings down that ARRIVED, though, is one a link asked for —
// the `versutus://add` sheet and its prefill — so it is held for the unlock to
// re-open rather than left lost: the operator unlocks onto the sheet the link
// asked for, not onto the Stack's first screen. A route the lock edge found is
// the operator's own and stays down.
//
// The gate has an unanswered window of its own, and the route at risk is the
// one that arrives in it: this gate mounts a commit before the device has
// answered — AppBootstrap withholds the Stack until it is bootstrapped and the
// deep-link router pushes into that same commit, which is how a
// `versutus://add` link tapped in a message cold-starts the app — while the
// answer waits on a storage read plus the biometric probe. So "not yet
// answered" is a state of its own, in which the gate dismisses nothing and
// consumes no arrival, and the answer decides whether that route is a link to
// hold or the operator's to keep.
//
// It only ever covers a device that can answer the biometric prompt — see
// app-lock.ts for why a removed enrollment must unlock rather than trap the
// operator. Nothing here reaches a gateway: the lock is a device preference.

import * as LocalAuthentication from 'expo-local-authentication';
import { type Href, useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
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
  heldRouteHref,
} from '@/lib/settings/app-lock';
import { deviceAppLockState } from '@/lib/settings/app-lock-device';

/** Modal asks Android for a back handler; the lock is not dismissable. */
const ignoreBackPress = () => undefined;

/**
 * The gate's own answer about this device, and the window before it has one:
 * `pending` until `deviceAppLockState()` resolves, then `locked` or `open`.
 */
type LockPhase = 'pending' | 'locked' | 'open';

export function AppLockGate({ children }: { children: React.ReactNode }) {
  const tokens = useTokens();
  const router = useRouter();
  // The presented route. Reading it is what arms the dismissal below for a
  // route the lock has not seen yet: the Stack's route list moving is the edge
  // a `versutus://add` link landing on a locked app produces.
  const presentedRoute = usePathname();
  // The route's own query, so the link the lock holds comes back with the
  // params its sheet was prefilled from.
  const routeParams = useGlobalSearchParams();
  const heldHref = heldRouteHref(presentedRoute, routeParams);
  // The device's answer, before it has one: the gate mounts a commit before
  // the read can settle, and that window is where a cold-start link's push
  // lands.
  const [phase, setPhase] = useState<LockPhase>('pending');
  // The read settles once; the background listener below needs the answer
  // without re-asking the device on every app-state change.
  const lockableRef = useRef(false);
  // The route this gate last accounted for. A route that differs from it is
  // one that arrived since the gate last had an answer, which is the one to
  // hold below — the unanswered window consumes nothing, so a route from it is
  // still an arrival when the answer lands. Nothing is accounted before the
  // first answer, so a route the app STARTED on is an arrival too: expo-router
  // seeds its navigation state from the URL that launched the app
  // (`getInitialURL`, native), which is how a cold-start `versutus://add` link
  // can already be the route on screen before this gate has ever answered.
  const accountedRouteRef = useRef<string | null>(null);
  // The link the lock brought down, waiting for the unlock to re-open it. A
  // ref, not state: nothing renders it, so holding one must not cost a render
  // — nor may it be lost to the renders the dismissal itself causes.
  const heldRouteRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const state = await deviceAppLockState();
      if (cancelled) return;
      const lockable = state.enabled && state.reason === null;
      lockableRef.current = lockable;
      setPhase(lockable ? 'locked' : 'open');
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
      if (state === 'background' && lockableRef.current) setPhase('locked');
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
  // pop, and the unlock never dismisses. The one route that is not left on the
  // first screen is one that ARRIVED while the lock was up: it is what a link
  // asked for, so it is held for the unlock to re-open. An unanswered gate is
  // exempt from all of it — that is the window a cold-start link's push lands
  // in, before the device's answer here is known.
  useEffect(() => {
    // Nothing happens until the device has answered, and nothing is consumed
    // either: a route that arrives in this window is still an arrival when the
    // answer lands. Accounting for it here is what left the lock edge to bring
    // the link's route down with nothing held.
    if (phase === 'pending') return;
    // Accounted for before the lock is consulted, so a route the app presented
    // while it had an answer is the operator's own — accounted for as it was
    // presented — rather than a link's arrival to hold. Only the first answer
    // can fold a route the gate has never seen, which is the link that
    // cold-started the app into its sheet.
    const arrived = presentedRoute !== accountedRouteRef.current;
    accountedRouteRef.current = presentedRoute;
    if (phase !== 'locked') return;
    // Nothing presented is the Stack on its first screen, so dismissing would
    // be a navigation for nothing — and it is the state this very dismissal
    // leaves behind, the pop landing here. That is why the hold is taken below
    // this guard: a route coming back down is not a new arrival to hold.
    if (!router.canDismiss()) return;
    if (arrived) heldRouteRef.current = heldHref;
    router.dismissAll();
  }, [phase, router, presentedRoute, heldHref]);

  // The unlock edge re-opens the link the lock brought down: the operator asked
  // for that route before the lock took it away. Its own effect rather than a
  // step inside `unlock`, because the unlock has to have landed first —
  // re-applying under any answer but `open` would hand the route straight back
  // to the dismissal above. Nothing navigates while the cover is up, and an
  // unanswered gate has held no link yet to re-open.
  useEffect(() => {
    if (phase !== 'open') return;
    const held = heldRouteRef.current;
    if (!held) return;
    heldRouteRef.current = null;
    router.push(held as Href);
  }, [phase, router]);

  const unlock = useCallback(async () => {
    try {
      // The device's own passcode stays a fallback (the module's default), so
      // a failed biometric is a retry here, not a way to lose the app.
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: APP_LOCK_UNLOCK_LABEL,
      });
      if (result.success) setPhase('open');
    } catch {
      // A prompt that could not run leaves the cover up; Unlock is the retry.
    }
  }, []);

  return (
    <>
      {children}
      <Modal
        visible={phase === 'locked'}
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
