// ─── A text shared into this app ───────────────────────────────────────────
// Item 5's Android half (FUTURE-ITEMS.md:193-194): the platform's share sheet
// hands Versutus another app's text as a SEND intent, and the words belong in a
// thread's composer as a draft — never in the send path. Reading the intent is
// the platform's business (`share-intent-native.ts`); what is decided here is
// what a shared payload BECOMES: the same `ComposeRequest` a
// `versutus://compose` link folds to, held on the provider until the Chat
// screen is showing a thread that can take it
// (`@/lib/gateway/compose-request`).
//
// A share is not a link: nothing addresses it. The sheet the operator shares
// from can say which Bot the text is for only if this app is the one drawing
// it, so a share names no Bot and its draft belongs to whichever thread is
// already up — the rule `composeRequestApplies` already follows for a link that
// names none. The iOS half of the package is a share extension rather than an
// intent and is not this slice: the config plugin declares Android only.

import { Platform } from 'react-native';

import type { ComposeRequest } from '@/lib/gateway/compose-request';
import {
  loadShareIntentPackage,
  type ShareIntentPackage,
} from '@/lib/gateway/share-intent-native';

/**
 * What a share hands over, reduced to the one field this slice reads. The
 * package's own `ShareIntent` is wider — files, a meta block, a type — and the
 * package's own parse is what fills `text` in: for a shared link the text is
 * the link (its parse keeps the whole shared string there and lifts the URL
 * out beside it), so a payload that carries words at all carries them here.
 */
export type SharedTextPayload = { text?: string | null };

/** The one thing a share can ask for: a text for the composer, or nothing. */
export function sharedTextRequest(payload: SharedTextPayload | null): ComposeRequest | null {
  const text = payload?.text;
  // The rule `deepLinkTarget` already follows for a link: a share with no
  // words, an empty one, or one that is only whitespace asks for nothing to
  // prefill. Shared content is untrusted input and the text is carried as the
  // other app wrote it — this fold decides only whether there is anything to
  // carry.
  if (text === undefined || text === null || !text.trim()) return null;
  return { text };
}

/** What the seam tells the router about: the parsed payload of one share. */
export type SharedTextListener = (payload: SharedTextPayload) => void;

/** The raw value the platform reports, as the package's own parse takes it. */
type ReportedShare = Parameters<ShareIntentPackage['parseShareIntent']>[0];

/** The package's own subscription handle. */
type ShareSubscription = { remove: () => void };

/**
 * Report every share the platform hands this app, and answer a function that
 * stops the reporting. Nothing is reported on a build with no native side — a
 * client built before the config plugin ran a prebuild — which is why the
 * answer is a promise: the ask costs a load.
 *
 * A share that arrives while the app is already running is delivered on its
 * own, through the listener. A share that LAUNCHED the app was recorded by the
 * platform before any listener existed, so the platform is asked whether it is
 * still holding one — once, and only after the listener is up, so the answer
 * has somewhere to go. Only Android is asked: iOS reaches this app through the
 * share extension instead, and its ask is the URL that opened the extension.
 */
export async function listenForSharedText(onShared: SharedTextListener): Promise<() => void> {
  const shareIntent = await loadShareIntentPackage();
  const module = shareIntent?.ShareIntentModule;
  if (!shareIntent || !module) return () => {};

  let subscription: ShareSubscription;
  try {
    subscription = module.addListener('onChange', (event: { value: ReportedShare }) => {
      onShared(shareIntent.parseShareIntent(event.value, {}));
    });
  } catch {
    // A platform that will not subscribe holds no share this app can read;
    // there is nothing left to stop.
    return () => {};
  }

  if (Platform.OS === 'android') {
    try {
      await module.getShareIntent('');
    } catch {
      // An ask the platform refuses leaves the listener up: a share that
      // arrives later is still reported.
    }
  }

  return () => subscription.remove();
}

/**
 * Forget the share the platform is holding, once its words have been handed to
 * the screen. The intent outlives being read, so without this the next
 * foreground would read the same share a second time into a draft that appends
 * — the operator's own words, twice. A build with no native side holds nothing
 * to forget.
 */
export async function dismissSharedText(): Promise<void> {
  const shareIntent = await loadShareIntentPackage();
  const module = shareIntent?.ShareIntentModule;
  if (!shareIntent || !module) return;

  try {
    await module.clearShareIntent(shareIntent.getShareExtensionKey());
  } catch {
    // Nothing to forget: the platform holds no share for this app.
  }
}
