// The Gate relays an approval notice as an Expo push the moment its card goes
// up. That notice is the only live event which names a run this phone did not
// open, so it belongs to the provider's connection surface — but the platform
// API lives here rather than in `gateway-provider.tsx`, which keeps its
// notification calls behind the shipped modules.
import * as Notifications from 'expo-notifications';

/** The payload keys this listener reads; everything else is ignored. */
export type ApprovalPush = {
  /** `'approval'` for the notice the Gate's push notifier sends. */
  kind?: unknown;
  /** The saved profile the push was registered for, when the Gate names it. */
  gatewayKey?: unknown;
};

/**
 * Watch for a relayed approval notice while the app is running.
 *
 * Returns the remover for that subscription. A platform (or test surface)
 * without the listener returns a no-op: the provider's poll remains the
 * fallback, so a phone that cannot receive pushes still learns the inbox.
 */
export function subscribeToApprovalPushes(
  onApproval: (push: ApprovalPush) => void,
): () => void {
  try {
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      const data = notification?.request?.content?.data;
      // A run, reply, routine or widget notice is another surface's news. Only
      // the approval marker means a row is waiting in this inbox.
      if (!data || data.kind !== 'approval') return;
      onApproval(data as ApprovalPush);
    });
    return () => {
      try {
        subscription?.remove();
      } catch {
        // A surface that cannot detach the listener has already stopped
        // delivering through it; the poll still owns the inbox.
      }
    };
  } catch {
    // No notification module on this surface: the poll is the only path.
    return () => undefined;
  }
}
