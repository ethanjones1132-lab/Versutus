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

export function extractReasoning(content: unknown): string {
  if (typeof content === 'string') return '';
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const typed = block as {
        type?: string;
        text?: string;
        thinking?: string;
        reasoning?: string;
        reasoning_content?: string;
        content?: string;
      };
      const t = typed.type;
      if (t !== 'thinking' && t !== 'reasoning' && t !== 'reasoning_content') return '';
      if (typeof typed.thinking === 'string' && typed.thinking) return typed.thinking;
      if (typeof typed.reasoning === 'string' && typed.reasoning) return typed.reasoning;
      if (typeof typed.reasoning_content === 'string' && typed.reasoning_content) return typed.reasoning_content;
      if (typeof typed.text === 'string' && typed.text) return typed.text;
      if (typeof typed.content === 'string' && typed.content) return typed.content;
      return '';
    })
    .join('');
}

/**
 * Read one tool result's payload for an outcome.
 *
 * The card says "Done" when the call has no evidence of failure, so the only
 * honest source for "Failed" is the result the tool itself returned. Everything
 * here is read off that payload — a structured `is_error`, a non-empty `error`,
 * `ok: false`, a failed `status`, a non-zero `exit_code`, or a result whose own
 * text opens with an error — never inferred from an exit code the app cannot
 * see. A payload that reports nothing about its outcome stays successful, which
 * is what the card already showed.
 */
export type ToolResultVerdict = {
  failed: boolean;
  /** The result's own text, when it has any, for the card's detail line. */
  detail?: string;
};

const FAILED_WORD = /^(?:error|errored|failed|failure|denied|cancelled|canceled|timeout|timed[ _]out)$/i;
const ERROR_OPENER = /^(?:error|failed|fatal)\b\s*[:\-–—]/i;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.trim()) parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === 'string' && text) parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function exitFailure(record: Record<string, unknown>): boolean {
  const raw = record.exitCode ?? record.exit_code;
  const code =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim()
        ? Number(raw)
        : undefined;
  return code !== undefined && Number.isFinite(code) && code !== 0;
}

function statusFailure(value: unknown): boolean {
  return typeof value === 'string' && FAILED_WORD.test(value.trim());
}

export function readToolResult(payload: unknown): ToolResultVerdict {
  if (typeof payload === 'string') {
    const text = payload.trim() ? payload : undefined;
    // A JSON result carries its own outcome fields; anything else is plain text
    // whose first line is the only thing it says about itself.
    if (text) {
      const parsed = tryParseToolJson(text);
      if (parsed && typeof parsed === 'object') {
        const verdict = readToolResult(parsed);
        return { failed: verdict.failed, detail: verdict.detail ?? text };
      }
    }
    return { failed: text !== undefined && ERROR_OPENER.test(text.trim()), detail: text };
  }

  if (Array.isArray(payload)) {
    // Anthropic-shaped content: one failed block fails the whole result.
    const failed = payload.some((block) => readToolResult(block).failed);
    return { failed, detail: contentText(payload) };
  }

  if (!payload || typeof payload !== 'object') return { failed: false };
  const record = payload as Record<string, unknown>;

  const detail =
    contentText(record.content)
    ?? nonEmptyString(record.output)
    ?? nonEmptyString(record.stdout)
    ?? nonEmptyString(record.stderr)
    ?? nonEmptyString(record.result)
    ?? nonEmptyString(record.text);

  const errorValue = record.error;
  const hasError = typeof errorValue === 'string'
    ? errorValue.trim() !== ''
    : errorValue !== undefined && errorValue !== null && typeof errorValue === 'object'
      && Object.keys(errorValue as Record<string, unknown>).length > 0;

  const failed =
    record.is_error === true ||
    record.isError === true ||
    record.ok === false ||
    record.success === false ||
    record.failed === true ||
    hasError ||
    statusFailure(record.status) ||
    statusFailure(record.state) ||
    exitFailure(record);

  return { failed, detail };
}

/** Parse a tool result that arrived as JSON text, ignoring anything else. */
function tryParseToolJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Attach the results history kept to the calls they belong to.
 *
 * A tool result is its own message (`role: 'tool'`, keyed by `tool_call_id`),
 * so the call's card is only as honest as this join. Calls without a matching
 * result keep the status they had.
 */
export function applyToolResults(
  toolCalls: ChatToolCall[],
  results: ReadonlyMap<string, ToolResultVerdict>,
): ChatToolCall[] {
  if (toolCalls.length === 0 || results.size === 0) return toolCalls;
  let changed = false;
  const next = toolCalls.map((call) => {
    if (!call.id) return call;
    const result = results.get(call.id);
    if (!result) return call;
    changed = true;
    // A failed call shows what the tool said (the reason is the whole point of
    // the card); a successful one keeps the arguments it was called with.
    const detail = result.failed
      ? (result.detail ?? call.detail)
      : (call.detail ?? result.detail);
    return {
      ...call,
      status: result.failed ? ('error' as const) : call.status,
      ...(detail !== undefined ? { detail } : {}),
    };
  });
  return changed ? next : toolCalls;
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

  const push = (
    name: string,
    status?: ChatToolCall['status'],
    detail?: string,
    id?: string,
  ) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Two calls of the same tool with the same arguments are still two pieces
    // of work when the backend gave them different ids: the id is what keeps a
    // repeated `shell` from folding into the first card.
    const key = `${id ?? ''}|${trimmed}|${detail ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...(id ? { id } : {}), name: trimmed, status: status ?? 'complete', detail });
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
        push(
          name,
          'complete',
          typeof raw.function?.arguments === 'string' ? raw.function.arguments : undefined,
          nonEmptyString(raw.id),
        );
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
        tool_use_id?: string;
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
        const callId =
          nonEmptyString(typed.id) ?? nonEmptyString(typed.tool_use_id);
        push(typeof name === 'string' ? name : 'tool', 'complete', detail, callId);
      }
    }
  }

  return out;
}

/**
 * Every tool result in one history page, keyed by the call it answers.
 *
 * Tool results are their own messages (`role: 'tool'`); dropping them is what
 * let a failed shell command read "Done" after a reload. Chunks of one result
 * are folded: any failure witness wins, and the longest text is the detail.
 */
export function collectToolResults(
  messages: unknown[],
  results: Map<string, ToolResultVerdict> = new Map<string, ToolResultVerdict>(),
): Map<string, ToolResultVerdict> {
  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue;
    const message = entry as {
      role?: string;
      content?: unknown;
      tool_call_id?: unknown;
      id?: unknown;
    };
    if (message.role !== 'tool') continue;
    const callId = nonEmptyString(message.tool_call_id) ?? nonEmptyString(message.id);
    if (!callId) continue;
    const verdict = readToolResult(message.content);
    const previous = results.get(callId);
    const detail =
      previous?.detail && previous.detail.length > (verdict.detail?.length ?? 0)
        ? previous.detail
        : verdict.detail;
    results.set(callId, { failed: verdict.failed || previous?.failed === true, detail });
  }
  return results;
}

export function historyToChatMessages(messages: unknown[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  // Read the page's tool results first: a result always follows its call, so a
  // single forward pass would have to hold every unanswered call open.
  const toolResults = collectToolResults(messages);
  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue;
    const message = entry as {
      role?: string;
      content?: unknown;
      timestamp?: number;
      id?: string;
      tool_calls?: unknown;
      toolCalls?: unknown;
      __openclaw?: { id?: string };
    };
    const role = message.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    const text = extractMessageText(message.content).trim();
    const reasoning = extractReasoning(message.content).trim();
    const toolCalls = applyToolResults(extractToolCalls(message), toolResults);
    // Keep assistant tool-only turns (text empty, tools present) and reasoning-only turns.
    if (!text && !reasoning && toolCalls.length === 0) continue;
    const explicitId =
      typeof message.__openclaw?.id === 'string' && message.__openclaw.id
        ? message.__openclaw.id
        : typeof message.id === 'string' && message.id
          ? message.id
          : undefined;
    const id = explicitId ?? createMessageId(role);
    result.push({
      id,
      role,
      text: text || (toolCalls.length > 0 ? '' : text),
      timestamp: message.timestamp,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      reasoning: reasoning ? reasoning : undefined,
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

/** What a pull-to-refresh at the top of a thread should do. */
export type PullRefreshAction = 'earlier' | 'reload';

/**
 * A pull at the very top of a thread that still has older pages pages back
 * (load earlier history) instead of re-reading the same window — the natural
 * "more history" gesture, mirroring the group-room/roster in-place re-read
 * discipline. Falls back to a plain reload when the thread is exhausted or an
 * earlier page is already in flight, so two overlapping gestures cannot run a
 * second page fetch (the merge itself is id-deduped in `prependEarlier`).
 */
export function resolvePullRefreshAction(args: {
  atTop: boolean;
  hasMoreHistory: boolean;
  loadingEarlierHistory: boolean;
}): PullRefreshAction {
  if (args.atTop && args.hasMoreHistory && !args.loadingEarlierHistory) return 'earlier';
  return 'reload';
}