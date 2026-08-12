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