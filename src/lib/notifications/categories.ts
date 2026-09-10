// ─── Notification categories (FUTURE-ITEMS.md §2, §6) ─────────────────────
// A notification category is what gives a notice its buttons: a category has
// to exist on the device before any notice may reference it, so the app
// registers every category it uses at startup — one call from
// NotificationRouter's mount effect in src/app/_layout.tsx. Registration is
// idempotent: expo replaces a category registered under an identifier it
// already knows, so a re-register on a later boot never duplicates the
// buttons.
//
// Two categories live here, and they answer opposite questions. The approval
// notice asks for a DECISION, so both of its actions are
// `opensAppToForeground: false` — the point is deciding a run from the banner
// without opening the app. Two facts bound how far that can go, and both are
// stated here rather than papered over: only runs THIS app initiated can be
// approved (CONTEXT.md, ADR 0001), and a KILLED app is never woken by a
// non-foregrounding action — expo v57 does not trigger the response listener
// at all in that case, so the fail-closed path belongs to the action handling,
// never to this registration. The bot-message notice asks for TEXT, and only
// this app can carry it to the Bot, so its reply action foregrounds — see
// BOT_MESSAGE_ACTIONS.
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

/**
 * `data.kind` marker an approval notice carries. Same word as the category on
 * purpose — one notice, one name — and the marker is what a tap or an action
 * reads to know the payload belongs to an approval rather than a run.
 */
export const APPROVAL_NOTICE_DATA_KIND = 'approval';

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
 * The category an inbound bot-message notice carries, so the operator can
 * answer a Bot from the banner instead of opening the app to find the
 * conversation. One bare word, not the dashed name the spec describes this
 * category by (`bot-message`): the rule in the header forbids `-` and `:` in a
 * category identifier, and the identifier is the whole contract between the
 * notice and its buttons.
 */
export const BOT_MESSAGE_CATEGORY_ID = 'botmessage';

/**
 * Action identifier for the reply button. It arrives as `actionIdentifier`,
 * and the text the operator typed arrives beside it as `response.userText` —
 * never in the notice payload.
 */
export const BOT_MESSAGE_REPLY_ACTION_ID = 'reply';

const BOT_MESSAGE_ACTIONS: Notifications.NotificationAction[] = [
  {
    identifier: BOT_MESSAGE_REPLY_ACTION_ID,
    buttonTitle: 'Reply',
    // The opposite of the approval buttons, on purpose: only this app can
    // carry a reply to the Bot Chat send path, and expo v57 triggers no
    // response listener for a non-foregrounding action on a killed app. So
    // "open the app" is what keeps the typed text from being dropped in
    // silence — the documented default, stated here so it is never traded for
    // a quieter button.
    options: { opensAppToForeground: true },
    // On Android the native action record reads `placeholder` alone; iOS also
    // shows `submitButtonTitle`, and the typings require both.
    textInput: {
      placeholder: 'Reply to this Bot',
      submitButtonTitle: 'Send',
    },
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
    await Notifications.setNotificationCategoryAsync(BOT_MESSAGE_CATEGORY_ID, BOT_MESSAGE_ACTIONS);
  } catch {
    // best-effort: notification must never break the app flow
  }
}
