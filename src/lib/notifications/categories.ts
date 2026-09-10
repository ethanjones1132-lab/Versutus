// ─── Notification categories (FUTURE-ITEMS.md §2) ─────────────────────────
// The approval notice's Approve / Deny buttons are a notification CATEGORY: a
// category has to exist on the device before any notice may reference it, so
// the app registers it at startup — one call from NotificationRouter's mount
// effect in src/app/_layout.tsx. Registration is idempotent: expo replaces a
// category registered under an identifier it already knows, so a re-register
// on a later boot never duplicates the buttons.
//
// Both actions are `opensAppToForeground: false`, because the point is
// deciding a run from the banner without opening the app. Two facts bound how
// far that can go, and both are stated here rather than papered over:
// only runs THIS app initiated can be approved (CONTEXT.md, ADR 0001), and a
// KILLED app is never woken by a non-foregrounding action — expo v57 does not
// trigger the response listener at all in that case, so the fail-closed path
// belongs to the action handling, never to this registration.
//
// Expo v57 docs (setNotificationCategoryAsync): the category identifier must
// not contain `:` or `-`, or matching breaks. The action identifiers follow
// the same rule.

import * as Notifications from 'expo-notifications';

/**
 * The category an approval notice carries in its `categoryIdentifier`. The
 * dashes/colons rule in the header is why this is one bare word.
 */
export const APPROVAL_CATEGORY_ID = 'approval';

/** Action identifier for approving the pending run; arrives as `actionIdentifier`. */
export const APPROVAL_APPROVE_ACTION_ID = 'approve';

/** Action identifier for denying the pending run; arrives as `actionIdentifier`. */
export const APPROVAL_DENY_ACTION_ID = 'deny';

const APPROVAL_ACTIONS: Notifications.NotificationAction[] = [
  {
    identifier: APPROVAL_APPROVE_ACTION_ID,
    buttonTitle: 'Approve',
    options: { opensAppToForeground: false },
  },
  {
    identifier: APPROVAL_DENY_ACTION_ID,
    buttonTitle: 'Deny',
    options: { isDestructive: true, opensAppToForeground: false },
  },
];

/**
 * Register every category a local notice may reference. Called once when the
 * app mounts.
 *
 * Best-effort by design: categories are an Android/iOS feature (expo v57 marks
 * `setNotificationCategoryAsync` `@platform android, ios`) and the module
 * throws `UnavailabilityError` where it is not implemented, so a web boot must
 * not crash over a button that platform cannot show.
 */
export async function registerNotificationCategories(): Promise<void> {
  try {
    await Notifications.setNotificationCategoryAsync(APPROVAL_CATEGORY_ID, APPROVAL_ACTIONS);
  } catch {
    // best-effort: notification must never break the app flow
  }
}
