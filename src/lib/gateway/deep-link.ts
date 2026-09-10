// ─── What a link into the app means ───────────────────────────────
// `GatewayDeepLinkRouter` used to decide this in place: a path compared
// against two literals, with the query normalized beside it. The vocabulary
// is what FUTURE-ITEMS item 8 compounds on — "one router, many entrances" —
// so it lives here as a fold a case can call, and the router keeps only the
// moving parts: navigate, open, ask for the surface.
//
// Three targets today. An `add` link prefills the add-gateway sheet (the
// shipped `versutus://add?url=…` pairing link). A `chat` link opens one Bot's
// Bot Chat, which is the vocabulary a donated Siri / Android shortcut will
// address; the Bot rides the `bot` query param. A `compose` link carries a
// shared text into the Chat composer as a draft, never as a send, and may
// name the Bot it is addressed to — the internal handoff item 5's share
// paths hand a shared text to.

/**
 * A parsed link's query, as expo-linking hands it over: a repeated param
 * arrives as an array and an absent one as undefined.
 */
export type DeepLinkQuery = Record<string, undefined | string | string[]>;

/**
 * Where a link lands. `add` carries the sheet's own params verbatim; `chat`
 * names the Bot whose Bot Chat opens; `compose` carries a shared text into
 * the composer, addressed to a Bot when the link names one.
 */
export type DeepLinkTarget =
  | { kind: 'add'; params: Record<string, string> }
  | { kind: 'chat'; botId: string }
  | { kind: 'compose'; text: string; botId?: string };

/** The first value of a repeated param, or undefined when the link carries none. */
function firstValue(value: undefined | string | string[]): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : undefined;
}

/**
 * Read a link's path and query into the one thing it asks for, or null when
 * it asks for nothing this app knows: an unrecognized path, or a `chat` with
 * no Bot in it, is a no-op rather than a guess at the nearest thread.
 *
 * The path is matched without its leading slashes and is otherwise exact —
 * the vocabulary the README and the pairing flow hand out has no other
 * spelling, so a case variant or a trailing slash is not a target.
 *
 * An `add` target's params are the link's own query minus every param that
 * is not a non-empty string, which is what the add sheet already prefills
 * from. A `chat` target's Bot id is trimmed, so a link built by hand with
 * padding still names the Bot it means.
 *
 * A `compose` target needs a text: a link carrying none, an empty one, or one
 * that is only whitespace asks for nothing to prefill and is a no-op, the same
 * as a `chat` with no Bot. The text itself is carried as the link spelled it —
 * shared content is untrusted input and this fold does not re-word it, the
 * rule the spoken draft states — and its Bot, when the link names one, is
 * trimmed exactly as a `chat` target trims it. A `compose` link naming no Bot
 * is still a target: its draft belongs to the surface already up.
 */
export function deepLinkTarget(
  path: string | null | undefined,
  query: DeepLinkQuery,
): DeepLinkTarget | null {
  const normalized = (path ?? '').replace(/^\/+/, '');

  if (normalized === 'add' || normalized === 'gateway/add') {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
      const first = firstValue(value);
      if (first !== undefined && first.length > 0) params[key] = first;
    }
    return { kind: 'add', params };
  }

  if (normalized === 'chat') {
    const botId = (firstValue(query.bot) ?? '').trim();
    return botId ? { kind: 'chat', botId } : null;
  }

  if (normalized === 'compose') {
    const text = firstValue(query.text);
    if (text === undefined || !text.trim()) return null;
    const botId = (firstValue(query.bot) ?? '').trim();
    return botId ? { kind: 'compose', text, botId } : { kind: 'compose', text };
  }

  return null;
}
