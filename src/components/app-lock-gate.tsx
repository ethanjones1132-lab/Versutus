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

import { AppLockPhaseProvider, type LockPhase } from '@/components/app-lock-phase';
import { VersutusMark } from '@/components/brand/versutus-mark';
import { Button, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import {
  APP_LOCK_COVER_BODY,
  APP_LOCK_COVER_TITLE,
  APP_LOCK_UNLOCK_LABEL,
  heldRouteHref,
  subscribeAppLock,
} from '@/lib/settings/app-lock';
import { deviceAppLockState } from '@/lib/settings/app-lock-device';

/** Modal asks Android for a back handler; the lock is not dismissable. */
const ignoreBackPress = () => undefined;

export type { LockPhase } from '@/components/app-lock-phase';

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
  // The phase as the AppState listener reads it. The listener is installed
  // once, so it cannot close over a render's value; this ref follows every
  // committed phase below.
  const phaseRef = useRef<LockPhase>('pending');
  // Whether a cover is up because the app is inactive, not because it is
  // locked. Kept apart from `phase` on purpose: a system prompt (the biometric
  // prompt included) reports 'inactive', and settling the phase on that edge
  // would relock the app the moment a successful unlock finished.
  const [coverOnInactive, setCoverOnInactive] = useState(false);
  // An unlock is a prompt the app is away for. An 'active' return that lands
  // while this is true belongs to that prompt, not to an operator coming back,
  // so it must not lift a cover the unlock is still deciding.
  const unlockingRef = useRef(false);
  // The ref follows every committed phase, so the listener below reads the
  // current answer rather than the one from its installing render.
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  // The device's answer, and the background listener below's only source of
  // truth: the verdict is refreshed on every write to the opt-in rather than
  // read once, so the switch in Settings takes effect without a cold start.
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

  // The one place this device is asked whether the lock holds. A verdict that
  // cannot be read keeps the previous one: a storage read that throws must
  // never read as "not locked" on the next background edge, and must never
  // seal a device out of its own gateways either.
  const readLockable = useCallback(async (): Promise<boolean> => {
    try {
      const state = await deviceAppLockState();
      const lockable = state.enabled && state.reason === null;
      lockableRef.current = lockable;
      return lockable;
    } catch {
      return lockableRef.current;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const lockable = await readLockable();
      if (cancelled) return;
      setPhase(lockable ? 'locked' : 'open');
    })();
    // Settings is the only writer, and it writes from another screen, so the
    // gate takes the notification rather than waiting for a cold start. The
    // refresh deliberately does NOT settle the phase: the operator who just
    // turned the lock on is in Settings with work in hand, and the cover goes
    // up on the next background edge — which is the edge that already exists
    // for exactly this.
    const unsubscribe = subscribeAppLock(() => {
      void readLockable();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [readLockable]);

  // Leaving the app locks it again: a cover that only appeared at launch would
  // leave the app readable in the switcher. Relocking waits for 'background'
  // and not 'inactive': a system prompt over the app reports 'inactive', and
  // relocking on that risks dropping a second cover the moment the operator
  // unlocks, so the gate takes the one edge that only a real leave produces.
  // The snapshot is a different job, though: iOS takes it on the way to
  // 'inactive', before 'background', so THIS edge puts the cover up through
  // `coverOnInactive` without touching `phase`. Coming back is the other cheap
  // place to refresh the verdict: the flag can have changed while the app was
  // away, and a cover already drawn is never lifted by this — only the
  // operator's unlock, or an 'active' return to a gate that is already open
  // with no unlock in flight, is.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'inactive') {
        setCoverOnInactive(true);
        return;
      }
      if (state === 'background') {
        if (lockableRef.current) setPhase('locked');
        return;
      }
      if (state === 'active') {
        void readLockable();
        // An 'active' edge while the biometric prompt is still deciding is the
        // prompt closing, not the operator returning: leave the cover for the
        // unlock's own answer, which clears it on success.
        if (phaseRef.current === 'open' && !unlockingRef.current) {
          setCoverOnInactive(false);
        }
      }
    });
    return () => subscription.remove();
  }, [readLockable]);

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
    if (unlockingRef.current) return;
    unlockingRef.current = true;
    try {
      // The device's own passcode stays a fallback (the module's default), so
      // a failed biometric is a retry here, not a way to lose the app.
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: APP_LOCK_UNLOCK_LABEL,
      });
      if (result.success) {
        setPhase('open');
        // The ref is the listener's answer too, and it must not lag the unlock
        // for the 'active' edge the prompt leaves behind.
        phaseRef.current = 'open';
        // The prompt's own 'inactive' edge put this cover up; the unlock is
        // what takes it back down, so it cannot outlive the lock it was for.
        setCoverOnInactive(false);
      }
    } catch {
      // A prompt that could not run leaves the cover up; Unlock is the retry.
    } finally {
      unlockingRef.current = false;
    }
  }, []);

  return (
    <AppLockPhaseProvider value={phase}>
      {children}
      <Modal
        visible={phase !== 'open' || coverOnInactive}
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
    </AppLockPhaseProvider>
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
