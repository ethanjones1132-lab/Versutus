// ─── Pure message-reducer for the chat surface ────────────────────
//
// These functions mirror the mutations `gateway-provider.tsx` performs on
// the local message list. Keeping them pure and in one place means:
//  - the MESSAGE_WINDOW_CAP is enforced on every growth path,
//  - streaming / error / abort behavior is unit-testable without React,
//  - future message state changes have a single place to live.

import { appendBounded } from '@/lib/gateway/messages';
import type { ChatMessage, ChatToolCall } from '@/lib/gateway/types';

function findStreamingIndex(messages: readonly ChatMessage[], runId: string): number {
  return messages.findIndex((m) => m.id === `run-${runId}`);
}

/** Append a user turn to the window. */
export function addUserMessage(messages: readonly ChatMessage[], text: string, id?: string): ChatMessage[] {
  const message: ChatMessage = {
    id: id ?? `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    text,
    timestamp: Date.now(),
  };
  return appendBounded([...messages], message);
}

/** Append the assistant placeholder that streaming deltas will patch. */
export function addStreamingPlaceholder(messages: readonly ChatMessage[], runId: string): ChatMessage[] {
  const placeholder: ChatMessage = {
    id: `run-${runId}`,
    role: 'assistant',
    text: '',
    streaming: true,
    timestamp: Date.now(),
  };
  return appendBounded([...messages], placeholder);
}

/** Append a streamed text delta to the placeholder. */
export function appendStreamDelta(
  messages: readonly ChatMessage[],
  runId: string,
  delta: string,
): ChatMessage[] {
  const idx = findStreamingIndex(messages, runId);
  if (idx < 0) return [...messages];
  const copy = [...messages];
  copy[idx] = { ...copy[idx], text: copy[idx].text + delta, streaming: true };
  return copy;
}

/** Merge a tool call into the streaming placeholder. */
export function appendToolCallDelta(
  messages: readonly ChatMessage[],
  runId: string,
  toolCall: ChatToolCall,
): ChatMessage[] {
  const idx = findStreamingIndex(messages, runId);
  if (idx < 0) return [...messages];
  const copy = [...messages];
  const existing = copy[idx].toolCalls ?? [];
  const match = existing.findIndex((item) => item.name === toolCall.name);
  const nextTools: ChatToolCall[] =
    match >= 0
      ? existing.map((item, i) => (i === match ? { ...item, ...toolCall } : item))
      : [...existing, toolCall];
  copy[idx] = { ...copy[idx], toolCalls: nextTools, streaming: true };
  return copy;
}

/** Mark the streaming placeholder complete, finalizing any running tools. */
export function finalizeStreamingMessage(messages: readonly ChatMessage[], runId: string): ChatMessage[] {
  const idx = findStreamingIndex(messages, runId);
  if (idx < 0) return [...messages];
  const copy = [...messages];
  const tools = copy[idx].toolCalls?.map((tool) =>
    tool.status === 'running' ? { ...tool, status: 'complete' as const } : tool,
  );
  copy[idx] = { ...copy[idx], streaming: false, toolCalls: tools };
  return copy;
}

/**
 * Convert a stream failure into its final state.
 * Abort removes the placeholder (the user intended to cancel).
 * Any other error keeps the bubble so the user sees what happened.
 */
export function convertStreamError(
  messages: readonly ChatMessage[],
  runId: string,
  errorMessage: string,
  isAbort: boolean,
): ChatMessage[] {
  if (isAbort) {
    return messages.filter((m) => m.id !== `run-${runId}`);
  }
  const idx = findStreamingIndex(messages, runId);
  if (idx < 0) return [...messages];
  const copy = [...messages];
  copy[idx] = {
    ...copy[idx],
    text: `Error: ${errorMessage}`,
    streaming: false,
  };
  return copy;
}

/**
 * Mark an in-flight stream as interrupted rather than completed.
 * Used when the connection drops mid-stream.
 */
export function markInterrupted(messages: readonly ChatMessage[], runId: string): ChatMessage[] {
  const idx = findStreamingIndex(messages, runId);
  if (idx < 0) return [...messages];
  const copy = [...messages];
  copy[idx] = { ...copy[idx], streaming: false, interrupted: true };
  return copy;
}

/**
 * Replace interrupted bubbles with authoritative history turns when possible.
 *
 * Matching is by text prefix: a history assistant turn whose text starts with
 * the interrupted bubble's accumulated text is treated as the same message.
 */
export function reconcileInterruptedMessages(
  current: readonly ChatMessage[],
  history: readonly ChatMessage[],
): ChatMessage[] {
  let changed = false;
  const next: ChatMessage[] = [];

  for (const message of current) {
    if (message.interrupted && message.role === 'assistant') {
      const prefix = message.text.trim();
      const match = history.find(
        (h) =>
          h.role === 'assistant' &&
          // History already in the list is not a reconciliation candidate.
          !current.some((m) => m.id === h.id) &&
          (prefix.length === 0 || h.text.trim().startsWith(prefix)),
      );
      if (match) {
        next.push(match);
        changed = true;
        continue;
      }
    }
    next.push(message);
  }

  return changed ? next : [...current];
}

/**
 * After a history reload on reconnect, bring back any interrupted bubbles that
 * have not yet been persisted to gateway history so the user can retry them.
 */
export function preserveInterruptedAfterReload(
  history: readonly ChatMessage[],
  previous: readonly ChatMessage[],
): ChatMessage[] {
  const prefix = (text: string) => text.trim().toLowerCase();
  const kept = history.filter((h) => h.role === 'assistant');
  const restored = previous.filter((message) => {
    if (!message.interrupted || message.role !== 'assistant') return false;
    const p = prefix(message.text);
    if (p.length === 0) return true;
    return !kept.some((h) => prefix(h.text).startsWith(p));
  });
  if (restored.length === 0) return [...history];
  const merged = [...history, ...restored];
  merged.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return merged;
}
