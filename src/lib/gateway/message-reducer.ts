// ─── Pure message-reducer for the chat surface ────────────────────
//
// These functions mirror the mutations `gateway-provider.tsx` performs on
// the local message list. Keeping them pure and in one place means:
//  - the MESSAGE_WINDOW_CAP is enforced on every growth path,
//  - streaming / error / abort behavior is unit-testable without React,
//  - future message state changes have a single place to live.

import type { ChatAttachment } from '@/lib/gateway/chat-parts';
import { appendBounded } from '@/lib/gateway/messages';
import type { TurnSettlementVerdict } from '@/lib/gateway/turn-resume';
import type { ChatMessage, ChatToolCall } from '@/lib/gateway/types';

function findStreamingIndex(messages: readonly ChatMessage[], runId: string): number {
  const byId = messages.findIndex((m) => m.id === `run-${runId}`);
  if (byId >= 0) return byId;
  // A re-attached turn writes into the bubble the live send was already filling,
  // which is keyed by the turn id it was minted for.
  return messages.findIndex((m) => m.turnId === runId);
}

/** The bubble that is the reply to `turnId`, by its own id or by its turn id. */
function findTurnIndex(messages: readonly ChatMessage[], turnId: string): number {
  const byId = messages.findIndex((m) => m.id === `run-${turnId}`);
  if (byId >= 0) return byId;
  return messages.findIndex((m) => m.turnId === turnId);
}

/** That bubble itself, when the list has one. */
function findTurnBubble(
  messages: readonly ChatMessage[],
  turnId: string,
): ChatMessage | undefined {
  const index = findTurnIndex(messages, turnId);
  return index >= 0 ? messages[index] : undefined;
}

/** Append a user turn to the window, with any image attachments (P1). */
export function addUserMessage(
  messages: readonly ChatMessage[],
  text: string,
  id?: string,
  attachments?: ChatAttachment[],
): ChatMessage[] {
  const message: ChatMessage = {
    id: id ?? `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    text,
    timestamp: Date.now(),
    ...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {}),
  };
  return appendBounded([...messages], message);
}

/**
 * Append the assistant placeholder that streaming deltas will patch.
 *
 * `turnId` is the Gate turn this reply belongs to, and it is the bubble's key:
 * a re-attached turn reads `run-${turnId}`, so a phone that comes back to a turn
 * it was already streaming writes into THIS bubble instead of raising a second
 * one beside it.
 */
export function addStreamingPlaceholder(
  messages: readonly ChatMessage[],
  runId: string,
  turnId?: string,
): ChatMessage[] {
  const placeholder: ChatMessage = {
    id: `run-${runId}`,
    role: 'assistant',
    text: '',
    streaming: true,
    timestamp: Date.now(),
    ...(turnId ? { turnId } : {}),
  };
  return appendBounded([...messages], placeholder);
}

/**
 * The streaming bubble for `turnId`, raised only when the thread has none.
 *
 * This is the re-attach path's whole move: a turn the Gate is still running is
 * the same turn whatever happened to the phone's connection, so its bubble is
 * re-used — interrupted or half-written — and streaming again. An interrupted
 * bubble that is followed afresh stops being interrupted, because the turn is
 * demonstrably not over.
 */
export function markTurnStreaming(
  messages: readonly ChatMessage[],
  turnId: string,
): ChatMessage[] {
  const idx = findTurnIndex(messages, turnId);
  if (idx < 0) return addStreamingPlaceholder([...messages], turnId, turnId);
  const copy = [...messages];
  const bubble = copy[idx];
  copy[idx] = {
    ...bubble,
    streaming: !isStoppedTurn(bubble),
    interrupted: false,
    interruptedReason: undefined,
    turnId,
  };
  return copy;
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
  // The transport keeps delivering for a tick after the abort lands, and a
  // delta that arrives after Stop settled the bubble must not put its orb back:
  // the turn is over as far as this thread is concerned, and `stopped` is the
  // only record of that once the streaming flag is gone.
  copy[idx] = { ...copy[idx], text: copy[idx].text + delta, streaming: !isStoppedTurn(copy[idx]) };
  return copy;
}

/** Append a streamed reasoning/thinking delta to the placeholder. */
export function appendReasoningDelta(
  messages: readonly ChatMessage[],
  runId: string,
  delta: string,
): ChatMessage[] {
  const idx = findStreamingIndex(messages, runId);
  if (idx < 0) return [...messages];
  const copy = [...messages];
  const prev = copy[idx].reasoning ?? '';
  copy[idx] = { ...copy[idx], reasoning: prev + delta, streaming: !isStoppedTurn(copy[idx]) };
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
  const match = existing.findIndex((item) =>
    toolCall.id ? item.id === toolCall.id : !item.id && item.name === toolCall.name,
  );
  const nextTools: ChatToolCall[] =
    match >= 0
      ? existing.map((item, i) => (i === match ? { ...item, ...toolCall } : item))
      : [...existing, toolCall];
  copy[idx] = { ...copy[idx], toolCalls: nextTools, streaming: !isStoppedTurn(copy[idx]) };
  return copy;
}

/** Mark the streaming placeholder complete, finalizing any running tools. */
export function finalizeStreamingMessage(messages: readonly ChatMessage[], runId: string): ChatMessage[] {
  const idx = findStreamingIndex(messages, runId);
  if (idx < 0) return [...messages];
  const copy = [...messages];
  // A turn that ends with finish_reason tool_calls may have no trailing content
  // delta — the stream simply closes. Without this promotion the ToolCallCard
  // would remain at 'Running' forever; the only other update path is an
  // explicit status-bearing appendToolCallDelta which most backends never send.
  //
  // An interrupted turn is not a finished one: its tools never reported back,
  // and promoting them would be the app claiming work that did not happen.
  const interrupted = copy[idx].interrupted === true;
  const tools = interrupted
    ? copy[idx].toolCalls
    : copy[idx].toolCalls?.map((tool) =>
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
  // The turn failed — any tool still marked Running would otherwise remain
  // there forever behind the error text, since finalizeStreamingMessage is not
  // called on this error path. Promote running tools to error so the card
  // reflects the terminal state.
  const tools = copy[idx].toolCalls?.map((tool) =>
    tool.status === 'running' ? { ...tool, status: 'error' as const } : tool,
  );
  copy[idx] = {
    ...copy[idx],
    text: `Error: ${errorMessage}`,
    streaming: false,
    toolCalls: tools,
  };
  return copy;
}

/**
 * Mark an in-flight stream as interrupted rather than completed.
 * Used when the connection drops mid-stream.
 */
export function markInterrupted(messages: readonly ChatMessage[], runId: string, reason?: string): ChatMessage[] {
  const idx = findStreamingIndex(messages, runId);
  if (idx < 0) return [...messages];
  const copy = [...messages];
  copy[idx] = { ...copy[idx], streaming: false, interrupted: true, interruptedReason: reason?.trim() || undefined };
  return copy;
}

/**
 * The marker a bubble the operator stopped with Stop carries.
 *
 * Deliberately not `interrupted`: an interruption is a turn whose connection
 * died and whose outcome the gateway may still be holding, and every reader of
 * that flag treats it as work still outstanding — the foreground reconcile, the
 * recovery ladder, and the per-run `getRunStatus` poll. A Stop is the operator's
 * own decision with nothing left to fetch, so dressing it as an interruption
 * bought one wasted history reload per deliberate stop.
 *
 * `ChatMessage` has no field for this and `types.ts` is outside this package's
 * allowed files, so the marker rides as an extra property and `isStoppedTurn`
 * is how anything reads it.
 */
export type StoppedTurnMarker = { stopped?: boolean; stoppedReason?: string };

/** Whether the operator stopped this turn themselves (see `stopStreamedTurns`). */
export function isStoppedTurn(message: ChatMessage): boolean {
  return (message as StoppedTurnMarker).stopped === true;
}

/**
 * Settle every in-flight bubble for the turns the operator stopped with Stop.
 *
 * Stopping is not failing: whatever already streamed is text the operator can
 * read, and throwing it away left an empty thread where an answer had been
 * half-written. A kept bubble is finalized — never left streaming, its running
 * tool cards promoted the way a finished turn promotes them — and carries the
 * stopped marker rather than `interrupted`.
 *
 * A turn that streamed nothing has nothing worth keeping and is removed,
 * exactly as an aborted turn always was. Every placeholder is settled, the way
 * the old filter removed every streaming message: naming one run left any other
 * orb wedged forever.
 */
export function stopStreamedTurns(
  messages: readonly ChatMessage[],
  reason = 'Stopped',
): ChatMessage[] {
  if (!messages.some((message) => message.streaming)) return [...messages];
  const trimmed = reason.trim() || undefined;
  const settled: ChatMessage[] = [];
  for (const message of messages) {
    if (!message.streaming) {
      settled.push(message);
      continue;
    }
    if (!message.text.trim()) continue;
    const tools = message.toolCalls?.map((tool) =>
      tool.status === 'running' ? { ...tool, status: 'complete' as const } : tool,
    );
    const kept: ChatMessage & StoppedTurnMarker = {
      ...message,
      streaming: false,
      stopped: true,
      stoppedReason: trimmed,
      toolCalls: tools,
    };
    settled.push(kept);
  }
  return settled;
}

/**
 * Append a system note to the thread (e.g. a failed bot-to-bot handoff).
 * Notes are visible in the transcript but excluded from outgoing conversation
 * context, so they inform the user without polluting the model's history.
 */
export function appendSystemNote(messages: readonly ChatMessage[], text: string): ChatMessage[] {
  const note: ChatMessage = {
    id: createNoteId(),
    role: 'system',
    text,
    timestamp: Date.now(),
  };
  return appendBounded([...messages], note);
}

function createNoteId(): string {
  return `system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

/**
 * After a history reload, bring back one turn's bubble when the reload dropped it.
 *
 * `preserveInterruptedAfterReload` restores bubbles the operator can see are
 * unfinished. This is the re-attach's half: the bubble of a turn this process
 * followed from the Gate's journal was never interrupted — it was streaming,
 * and streaming is what a live turn owns — so that restore leaves it out, and
 * the reload drops it along with the answer it had already written. It goes
 * back unless the reloaded history already shows the same words, in which case
 * the Gate's own record of the turn is what belongs on the thread.
 */
export function preserveTurnBubbleAfterReload(
  history: readonly ChatMessage[],
  previous: readonly ChatMessage[],
  turnId: string,
): ChatMessage[] {
  const bubble = findTurnBubble(previous, turnId);
  if (!bubble) return [...history];
  if (history.some((message) => message.id === bubble.id)) return [...history];
  const answer = bubble.text.trim().toLowerCase();
  const shown = history.some(
    (message) =>
      message.role === 'assistant' &&
      answer.length > 0 &&
      message.text.trim().toLowerCase().startsWith(answer),
  );
  if (shown) return [...history];
  const merged = [...history, bubble];
  merged.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return merged;
}

/**
 * Run ids of assistant bubbles still sitting in the interrupted state.
 *
 * The in-flight bubble is keyed `run-${runId}`, so the id round-trips back out.
 * Only bubbles that carry a run id can be settled from a run result; a bubble
 * interrupted before its run id was known is left for history reconciliation.
 */
export function interruptedRunIds(messages: readonly ChatMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (!message.interrupted || message.role !== 'assistant') continue;
    if (!message.id.startsWith('run-')) continue;
    const runId = message.id.slice('run-'.length);
    if (runId) ids.push(runId);
  }
  return [...new Set(ids)];
}

export type InterruptedRunResolution = {
  runId: string;
  /** Terminal text from the gateway, when the run produced one. */
  text?: string;
  /** True when the run reached a terminal failure. */
  failed?: boolean;
};

/**
 * Replace interrupted bubbles with the authoritative outcome of their run.
 *
 * `reconcileInterruptedMessages` can only settle a bubble that history happens
 * to contain. A run that finished on the gateway *after* the disconnect is
 * often absent from the history page the client just reloaded, which left the
 * bubble stuck as interrupted until the user reloaded again by hand. Polling
 * the run directly closes that gap.
 *
 * A resolution with no text is ignored rather than blanking the bubble — the
 * partial text the user can already see is better than nothing.
 */
export function settleInterruptedFromRuns(
  messages: readonly ChatMessage[],
  resolutions: readonly InterruptedRunResolution[],
): ChatMessage[] {
  if (resolutions.length === 0) return [...messages];
  const byRunId = new Map(resolutions.map((item) => [item.runId, item]));

  return messages.map((message) => {
    if (!message.interrupted || message.role !== 'assistant') return message;
    if (!message.id.startsWith('run-')) return message;

    const resolution = byRunId.get(message.id.slice('run-'.length));
    if (!resolution) return message;

    const text = resolution.text?.trim();
    if (!text && !resolution.failed) return message;

    return {
      ...message,
      interrupted: false,
      interruptedReason: undefined,
      streaming: false,
      text: text || message.text,
      ...(resolution.failed ? { command: { ...message.command, status: 'error' as const } } : {}),
    };
  });
}

/**
 * Turn ids of assistant bubbles still sitting in the interrupted state.
 *
 * This is the counterpart of `interruptedRunIds` for bubbles that carry the Gate
 * turn they were the reply to: those can be settled by asking the journal what
 * became of the turn, which no history read can answer.
 */
export function interruptedTurnIds(messages: readonly ChatMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (!message.interrupted || message.role !== 'assistant') continue;
    const turnId = message.turnId ?? (message.id.startsWith('run-') ? message.id.slice('run-'.length) : undefined);
    if (turnId) ids.push(turnId);
  }
  return [...new Set(ids)];
}

/** One bubble's settlement, read off the Gate's journal. */
export type TurnSettlementResolution = {
  turnId: string;
  settlement: TurnSettlementVerdict;
};

/**
 * Settle bubbles by turn IDENTITY — what the Gate's journal says became of the
 * turn, rather than whether reloaded history happens to contain a matching
 * prefix.
 *
 * The rules, all of them about not claiming more than happened:
 *  - `done` with text becomes the final text. A `done` with NO text (a journal
 *    that dropped its delta events) is left alone: the partial text the operator
 *    can already read beats blanking the bubble, and the history reload that
 *    follows still has the finished turn.
 *  - `failed` keeps what streamed and says why in the interruption reason. It is
 *    not a red failure card: the turn's own error text is the truth here.
 *  - `cancelled` is marked stopped, exactly as the operator's own Stop marks a
 *    turn — the operator (or another device) decided this, and there is nothing
 *    left to fetch.
 *  - `interrupted` keeps the interrupted marker and names the reason. Its
 *    running tool calls stay running: the Gate ended the turn, so nothing ever
 *    reported those tools finished.
 */
export function settleInterruptedFromTurns(
  messages: readonly ChatMessage[],
  resolutions: readonly TurnSettlementResolution[],
): ChatMessage[] {
  if (resolutions.length === 0) return [...messages];
  const byTurnId = new Map(resolutions.map((item) => [item.turnId, item.settlement]));

  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    if (!message.interrupted && !message.streaming) return message;
    const turnId = message.turnId ?? (message.id.startsWith('run-') ? message.id.slice('run-'.length) : undefined);
    if (!turnId) return message;
    const settlement = byTurnId.get(turnId);
    if (!settlement) return message;
    // A turn the operator stopped is the operator's decision, and the re-attach
    // that stopped is still settling it.
    if (isStoppedTurn(message)) return message;

    switch (settlement.kind) {
      case 'done': {
        const text = settlement.text.trim();
        if (!text) return message;
        const tools = message.toolCalls?.map((tool) =>
          tool.status === 'running' ? { ...tool, status: 'complete' as const } : tool,
        );
        return {
          ...message,
          interrupted: false,
          interruptedReason: undefined,
          streaming: false,
          text,
          ...(tools ? { toolCalls: tools } : {}),
        };
      }
      case 'failed':
        return {
          ...message,
          interrupted: true,
          streaming: false,
          interruptedReason: settlement.message,
        };
      case 'cancelled': {
        const tools = message.toolCalls?.map((tool) =>
          tool.status === 'running' ? { ...tool, status: 'complete' as const } : tool,
        );
        const settled: ChatMessage & StoppedTurnMarker = {
          ...message,
          streaming: false,
          interrupted: false,
          interruptedReason: undefined,
          stopped: true,
          stoppedReason: 'Stopped',
          ...(tools ? { toolCalls: tools } : {}),
        };
        return settled;
      }
      case 'interrupted':
        return {
          ...message,
          streaming: false,
          interrupted: true,
          interruptedReason: settlement.copy,
        };
      default:
        return message;
    }
  });
}
