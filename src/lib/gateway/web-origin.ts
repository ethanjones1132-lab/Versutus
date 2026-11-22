// The web build runs on its own origin (Metro's dev port, or the static demo
// server). That page is cross-origin to the Gate, so the browser blocks every
// call — manifest, pairing, runs, SSE replay — before the Gate's router sees it
// unless the Gate was started with that exact origin on its allow-list.
//
// Native builds talk to the Gate from React Native, where the same-origin
// policy does not exist, so nothing here changes what they show or send.

// A page origin is exactly scheme://host[:port]: no path, query, fragment or
// whitespace. `window.location.origin` serializes an opaque origin (file://,
// data:) as the string "null"; the Gate's CLI refuses any value that is not
// http(s), so a missing or opaque value must never become a dangling
// `--allow-origin` argument.
const EXACT_WEB_ORIGIN = /^https?:\/\/[^/?#\s]+$/i;

/** The page's exact origin, or null when this is not a normal http(s) page. */
export function exactWebOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const origin = raw.trim();
  return EXACT_WEB_ORIGIN.test(origin) ? origin : null;
}

/** The running page's origin where a DOM exists; undefined on native. */
export function currentWebOrigin(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const origin = (window as { location?: { origin?: unknown } }).location?.origin;
  return typeof origin === 'string' ? origin : undefined;
}

/**
 * The Gate start command for the web build, carrying this page's exact origin
 * so the Gate opts that one origin in. With no usable origin the command stays
 * runnable rather than naming an origin we do not know (or an empty one).
 */
export function webGateStartCommand(origin: unknown): string {
  const exact = exactWebOrigin(origin);
  return exact
    ? `node gate/cli.mjs start --allow-origin ${exact}`
    : 'node gate/cli.mjs start';
}

/**
 * What a browser is told after a failed manual connection. It names the origin
 * the Gate has to allow as one of the things to check — it does not claim CORS
 * is the cause, because a blocked fetch and an unreachable host look identical
 * to the browser.
 */
export function webUnreachableCopy(origin: unknown): string {
  const exact = exactWebOrigin(origin);
  const allowed = exact
    ? `was started with --allow-origin ${exact}`
    : 'allows this page’s origin (--allow-origin)';
  return `Could not reach the gateway from this browser. Check its address, then make sure the Gate is running and ${allowed}.`;
}

/**
 * The probe line a manual attempt leaves behind. The native wording points at
 * Tailscale, which cannot explain a denial that only exists in a browser.
 */
export function savedAddressUnreachableCopy(options: {
  web: boolean;
  origin?: unknown;
}): string {
  if (options.web) {
    const exact = exactWebOrigin(options.origin);
    return exact
      ? `Saved your address, but could not reach the gateway. Make sure it is running and allows ${exact}.`
      : 'Saved your address, but could not reach the gateway. Make sure it is running and allows this page’s origin.';
  }
  return 'Saved your address, but could not reach the gateway. Make sure it is running and exposed over Tailscale or local network.';
}
