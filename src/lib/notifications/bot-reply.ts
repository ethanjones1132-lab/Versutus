// ─── Pure reader for a quick reply (FUTURE-ITEMS.md §6) ───────────────────
// Free of expo-notifications calls, so the shape rules below are jest-pinnable
// without mocks. The response listener in src/app/_layout.tsx reads the
// response's action identifier, the text the operator typed into the notice's
// reply button (`response.userText`, which arrives beside the identifier and
// never inside the payload) and the payload naming the Bot the notice came
// from, then hands the reply to the ordinary chat send path.
//
// The payload contract is `{ botId, sessionId }`: the Bot whose canonical Bot
// Chat is the destination (ADR 0012) and the session the notice was about. No
// producer writes it yet — §6 sequences inbound bot-message notices after item 1
// gives Bots a reason to notify, and Solution A5 fixes the same shape for the
// relay — so the contract is defined here, once, for whoever produces it.
//
// A reply is never fabricated. Text that is empty or only whitespace, and a
// payload whose ids are absent or half-shaped, are not a reply: the caller has
// nothing to send and must not send anything.

/** The reply the operator typed, and the Bot Chat it belongs to. */
export type BotReply = {
  botId: string;
  sessionId: string;
  text: string;
};

/**
 * The reply a bot-message notice's action carries, or null when there is none
 * to send.
 *
 * What says "this is a reply" is the action identifier — the caller compares it
 * to BOT_MESSAGE_REPLY_ACTION_ID — so this reads only what the response itself
 * supplies. The text is trimmed, because a button submitted with spaces holds
 * no words and sends none. Both ids must be present and non-empty for the same
 * reason routeForTap refuses a half-shaped route: a Bot this app cannot name is
 * not a destination, and guessing one would put the operator's words in another
 * conversation.
 */
export function botReplyFromResponse(data: unknown, userText: unknown): BotReply | null {
  if (typeof userText !== 'string') return null;
  const text = userText.trim();
  if (!text) return null;
  if (!data || typeof data !== 'object') return null;
  const payload = data as Record<string, unknown>;
  const botId = nonEmptyString(payload.botId);
  const sessionId = nonEmptyString(payload.sessionId);
  if (!botId || !sessionId) return null;
  return { botId, sessionId, text };
}

/** Why a quick reply did not go out — and so what its follow-up notice says. */
export type BotReplyNoticeReason = 'queued' | 'bot-chat-unavailable';

/** The copy one reason wears; the caller posts it unchanged. */
export interface BotReplyNoticeCopy {
  title: string;
  body: string;
}

const BOT_REPLY_NOTICE_COPY: Record<BotReplyNoticeReason, BotReplyNoticeCopy> = {
  queued: {
    title: 'Reply queued',
    body: 'No connection to the gateway — your reply is saved and sends when Versutus reconnects.',
  },
  'bot-chat-unavailable': {
    title: 'Reply not sent',
    body: "Versutus couldn't open this Bot's chat. Open Versutus to reply.",
  },
};

/**
 * The copy for a reply that did not go out. Neither notice claims the Bot read
 * anything, that a message was delivered, nor a count of anything: the operator
 * typed words and is told exactly where they are — saved for the next
 * connection, or not sent at all.
 */
export function botReplyNoticeCopy(reason: BotReplyNoticeReason): BotReplyNoticeCopy {
  return BOT_REPLY_NOTICE_COPY[reason];
}

/** A present, non-empty string id — anything else is not an id. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
