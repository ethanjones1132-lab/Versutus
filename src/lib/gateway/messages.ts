import type { ChatMessage, ChatToolCall, HermesSession } from '@/lib/gateway/types';

/** `source` the gateway stamps on sessions created through its HTTP API. */
export const APP_SESSION_SOURCE = 'api_server';

/**
 * The newest session this app owns. A gateway also hosts sessions belonging to
 * other surfaces — the desktop TUI, Discord, cron — and adopting the newest of
 * those would drop an unrelated conversation into the user's chat.
 * Sessions arrive newest-first.
 */
export function pickAppSession(sessions: HermesSession[]): HermesSession | undefined {
  return sessions.find((session) => session.source === APP_SESSION_SOURCE);
}

export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const typed = block as { type?: string; text?: string };
      if (typed.type === 'text' && typeof typed.text === 'string') return typed.text;
      return '';
    })
    .join('');
}

/**
 * Pull tool invocations from common history shapes:
 * - OpenAI `tool_calls` on the message
 * - content blocks with type tool_use / tool_call / function_call
 * Returns [] when nothing is present (UI should simply omit the cards).
 */
export function extractToolCalls(message: {
  content?: unknown;
  tool_calls?: unknown;
  toolCalls?: unknown;
}): ChatToolCall[] {
  const out: ChatToolCall[] = [];
  const seen = new Set<string>();

  const push = (name: string, status?: ChatToolCall['status'], detail?: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const key = `${trimmed}|${detail ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: trimmed, status: status ?? 'complete', detail });
  };

  const list = message.tool_calls ?? message.toolCalls;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const raw = entry as {
        type?: string;
        function?: { name?: string; arguments?: string };
        name?: string;
        id?: string;
      };
      const name = raw.function?.name ?? raw.name;
      if (typeof name === 'string') {
        push(name, 'complete', typeof raw.function?.arguments === 'string' ? raw.function.arguments : undefined);
      }
    }
  }

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      const typed = block as {
        type?: string;
        name?: string;
        id?: string;
        input?: unknown;
        function?: { name?: string; arguments?: string };
      };
      if (
        typed.type === 'tool_use' ||
        typed.type === 'tool_call' ||
        typed.type === 'function_call' ||
        typed.type === 'tool'
      ) {
        const name = typed.name ?? typed.function?.name ?? typed.id ?? 'tool';
        const detail =
          typeof typed.function?.arguments === 'string'
            ? typed.function.arguments
            : typed.input != null
              ? JSON.stringify(typed.input).slice(0, 200)
              : undefined;
        push(typeof name === 'string' ? name : 'tool', 'complete', detail);
      }
    }
  }

  return out;
}

export function historyToChatMessages(messages: unknown[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue;
    const message = entry as {
      role?: string;
      content?: unknown;
      timestamp?: number;
      tool_calls?: unknown;
      toolCalls?: unknown;
      __openclaw?: { id?: string };
    };
    const role = message.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    const text = extractMessageText(message.content).trim();
    const toolCalls = extractToolCalls(message);
    // Keep assistant tool-only turns (text empty, tools present).
    if (!text && toolCalls.length === 0) continue;
    const id =
      typeof message.__openclaw?.id === 'string'
        ? message.__openclaw.id
        : `${role}-${message.timestamp ?? result.length}`;
    result.push({
      id,
      role,
      text: text || (toolCalls.length > 0 ? '' : text),
      timestamp: message.timestamp,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    });
  }
  return result;
}

export function createMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Bounded in-memory message window ─────────────────────────────
// Chat appends one entry per send and per stream delta. Left unbounded the
// list grows for the lifetime of a session — the long-running agent tasks
// this app exists for are exactly the case that pushes it to OOM. Older
// turns stay durable in gateway history; only the in-memory window is capped.

/** How many chat messages are kept in memory before the oldest are dropped. */
export const MESSAGE_WINDOW_CAP = 200;

/** Trim a list to its newest `cap` entries, returning it as-is when it fits. */
export function boundWindow<T>(list: T[], cap: number = MESSAGE_WINDOW_CAP): T[] {
  // Returning the original reference keeps React from re-rendering on a no-op.
  return list.length <= cap ? list : list.slice(list.length - cap);
}

/** Append one entry, dropping the oldest entries past `cap`. */
export function appendBounded<T>(list: T[], item: T, cap: number = MESSAGE_WINDOW_CAP): T[] {
  return boundWindow([...list, item], cap);
}

/**
 * Whether a "load earlier" page likely has more history behind it.
 *
 * The history endpoint takes only a limit — no offset or cursor — so a page
 * shorter than what was requested is the only signal that the beginning of
 * the session has been reached.
 */
export function hasEarlierHistory(returnedCount: number, requestedLimit: number): boolean {
  return returnedCount >= requestedLimit && requestedLimit > 0;
}

/**
 * Page older messages in ahead of the current window, skipping any already
 * present.
 *
 * Deliberately does **not** re-apply `MESSAGE_WINDOW_CAP`: the cap exists to
 * stop runaway streaming growth, and re-bounding here would discard exactly
 * the history the user just asked to see.
 */
export function prependEarlier<T extends { id: string }>(current: T[], earlier: T[]): T[] {
  if (earlier.length === 0) return current;
  const present = new Set(current.map((item) => item.id));
  const fresh = earlier.filter((item) => !present.has(item.id));
  // Same reference when the page was entirely overlap — no needless re-render.
  return fresh.length === 0 ? current : [...fresh, ...current];
}