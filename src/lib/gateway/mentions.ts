import { formatRunFailure } from '@/lib/gateway/run-failures';

export function extractMentions(text: string, rosterIds: string[]): string[] {
  const allowed = new Set(rosterIds.map((id) => id.toLowerCase()));
  const found: string[] = [];
  const seen = new Set<string>();
  const pattern = /@([a-z0-9][a-z0-9_-]{0,62})/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text ?? '')) !== null) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (text[end] === '@') continue;
    const id = match[1].toLowerCase();
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    const canonical = rosterIds.find((entry) => entry.toLowerCase() === id) ?? id;
    found.push(canonical);
  }
  return found;
}

const MENTION_TOKEN_CHAR = /[a-z0-9_-]/i;
const MENTION_TOKEN_START = /[a-z0-9]/i;

function isMentionTokenChar(ch: string | undefined): boolean {
  return !!ch && MENTION_TOKEN_CHAR.test(ch);
}

/**
 * The @token the caret sits in: prefix is what has been typed to the left of
 * the caret (empty right after `@`); start/end span the whole token so a pick
 * replaces it rather than splicing. Null when the caret is not inside one —
 * including email-shaped `@user@host`, which extractMentions also skips.
 */
export function mentionTokenAtCaret(
  text: string,
  caret: number,
): { prefix: string; start: number; end: number } | null {
  const value = text ?? '';
  const pos = Math.min(Math.max(caret, 0), value.length);
  let i = pos;
  while (i > 0 && isMentionTokenChar(value[i - 1])) i -= 1;
  if (i === 0 || value[i - 1] !== '@') return null;
  const start = i - 1;
  let end = pos;
  while (end < value.length && isMentionTokenChar(value[end])) end += 1;
  if (value[end] === '@') return null;
  const body = value.slice(start + 1, end);
  if (body.length > 0 && !MENTION_TOKEN_START.test(body[0])) return null;
  return { prefix: value.slice(start + 1, pos), start, end };
}

/** Room members whose id starts with the typed prefix. Empty prefix is the whole room. */
export function filterMentionMembers(prefix: string, memberIds: string[]): string[] {
  const needle = (prefix ?? '').toLowerCase();
  return memberIds.filter((id) => id.toLowerCase().startsWith(needle));
}

export function mentionPicksAtCaret(text: string, caret: number, memberIds: string[]): string[] {
  const token = mentionTokenAtCaret(text, caret);
  if (!token) return [];
  return filterMentionMembers(token.prefix, memberIds);
}

/**
 * Replace the @token at the caret with `@memberId` plus a trailing space so
 * the next keystroke is prose. extractMentions then sees the canonical id.
 */
export function insertMention(text: string, caret: number, memberId: string): string {
  const value = text ?? '';
  const token = mentionTokenAtCaret(value, caret);
  if (!token) return value;
  const before = value.slice(0, token.start);
  const after = value.slice(token.end);
  const inserted = `@${memberId}`;
  if (after.length === 0 || after.startsWith(' ') || after.startsWith('\n')) {
    return after.length === 0 ? `${before}${inserted} ` : `${before}${inserted}${after}`;
  }
  return `${before}${inserted} ${after}`;
}

export function mentionPrefix(fromId: string, text: string): string {
  return `Message from 🤖 ${fromId} (@${fromId}):\n\n${text}`;
}

/**
 * System-note wording shown when the bot roster could not be loaded after a
 * reply, so @mention handoffs could not even be attempted. Honest by design:
 * the user typed an @mention and must know it was not delivered.
 */
export function rosterUnavailableNote(error: string): string {
  return `Handoff skipped: the bot roster could not be loaded (${error}). @mentions in your message were not delivered.`;
}

/**
 * System-note wording shown when delivering an @mention handoff to a bot
 * failed. Handoff refusals are Bot-routing failures (the Gate's `forBot`
 * refuses with the same messages a direct send gets), so a classifiable
 * failure appends the desktop-parity verdict + fix instead of leaving the
 * operator to decode raw text.
 */
export function handoffFailedNote(toId: string, error: string): string {
  const fix = formatRunFailure(error);
  return fix ? `Handoff to @${toId} failed: ${fix}` : `Handoff to @${toId} failed: ${error}.`;
}
