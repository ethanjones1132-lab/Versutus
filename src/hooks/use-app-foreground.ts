import { useSyncExternalStore } from 'react';
import { AppState, type NativeEventSubscription } from 'react-native';

let foreground = AppState.currentState === 'active';
let subscription: NativeEventSubscription | undefined;
const listeners = new Set<() => void>();

function snapshot(): boolean {
  return foreground;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!subscription) {
    foreground = AppState.currentState === 'active';
    subscription = AppState.addEventListener('change', (state) => {
      const next = state === 'active';
      if (next === foreground) return;
      foreground = next;
      for (const notify of listeners) notify();
    });
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      subscription?.remove();
      subscription = undefined;
    }
  };
}

/** True only while the app is active, with one shared native listener. */
export function useAppForeground(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
