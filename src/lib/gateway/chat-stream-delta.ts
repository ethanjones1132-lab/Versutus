import type { ChatToolCall } from '@/lib/gateway/types';
import { readToolResult } from '@/lib/gateway/messages';

export type ChatToolStatus = 'running' | 'complete' | 'error';

export type ChatStreamAcc = {
  toolNames: Map<number, string>;
  toolArgs: Map<number, string>;
  toolIds: Map<number, string>;
  toolDetails: Map<number, string>;
  /**
   * The last status each tool slot was actually reported with, keyed per slot.
   *
   * A provider splits one tool call across frames and only some of them carry a
   * `status`; the rest say nothing at all. Reading those silent fragments as
   * "running" put a finished card back into its running state — the turn had
   * already said the tool completed or failed, and a later fragment of the same
   * call is not new evidence about it. `complete` and `error` are therefore
   * sticky: remembered here so a fragment without a status inherits the truth
   * instead of implying one.
   */
  toolStatus: Map<string, ChatToolStatus>;
  /**
   * The tool id each array-form block slot currently holds.
   *
   * Anthropic-shaped streams name a `tool_use` block once, at its start; the
   * deltas that follow carry only the block index. Remembering the id per slot
   * is what lets a later fragment stay the SAME call — without it every
   * fragment is a nameless, id-less call and the reducer can only fall back to
   * matching by tool name.
   */
  blockIds: Map<string, string>;
  /**
   * The call id each slot was last seen holding.
   *
   * A slot is not a call. An agent that runs `shell`, reads the result, then
   * runs `shell` again reuses the same provider slot, and the id is the only
   * evidence that the second invocation is new work: when it changes, the
   * accumulated name and arguments of the first must not be inherited.
   */
  slotCallIds: Map<string, string>;
  /** The name each known call id was announced with, so a result can settle it. */
  namesById: Map<string, string>;
};

export function createChatStreamAcc(): ChatStreamAcc {
  return {
    toolNames: new Map(),
    toolArgs: new Map(),
    toolIds: new Map(),
    toolDetails: new Map(),
    toolStatus: new Map(),
    blockIds: new Map(),
    slotCallIds: new Map(),
    namesById: new Map(),
  };
}

function isToolStatus(value: unknown): value is ChatToolStatus {
  return value === 'running' || value === 'complete' || value === 'error';
}

/**
 * Resolve the status for one tool slot and remember it.
 *
 * A terminal status reported for a call is not undone by a later fragment:
 * `complete` is how the card left its spinner, and nothing short of a caller
 * settling the turn (`finalizeStreamingMessage` / `convertStreamError`) may
 * take that away. A frame that reports no status at all inherits the last
 * known one, so it never implies `running` on its own.
 *
 * The key includes the call id when the frame names one, so a NEW invocation in
 * a reused slot starts with no history of the previous one: otherwise the
 * second `shell` of a turn would be born holding the first one's `complete`.
 */
function resolveToolStatus(
  acc: ChatStreamAcc,
  slot: string,
  reported: unknown,
  callId?: string,
): ChatToolStatus {
  const key = callId ? `${slot}|${callId}` : slot;
  const previous = acc.toolStatus.get(key);
  const explicit = isToolStatus(reported) ? reported : undefined;
  const status: ChatToolStatus =
    previous === 'complete' || previous === 'error'
      ? previous
      : explicit ?? previous ?? 'running';
  acc.toolStatus.set(key, status);
  return status;
}

export type ChatStreamInterpretation = {
  text?: string;
  reasoning?: string;
  toolCalls: ChatToolCall[];
  streamError?: string;
  telemetryWarning?: string;
  /**
   * The model that actually served the turn, as the Gate reports it once the
   * turn resolves. Backends substitute — Hermes falls through
   * `fallback_providers` and answers as a different model entirely — so this
   * is the only honest name for what replied. Absent on gateways that do not
   * report it, which must read as "unknown", never as confirmation.
   */
  ranModel?: string;
  /** The model that was asked for, echoed back so a swap is self-evident. */
  requestedModel?: string;
  /** The provider that served it, when reported. */
  provider?: string;
};

/**
 * Array-form `delta.content` block kinds known to carry tool calls. The Gate
 * relays provider chunks verbatim, so a future provider can introduce a new
 * kind — anything outside this set falls through to the unknown-kind fallback
 * below instead of being silently dropped. `tool_result` is outside the set on
 * purpose: it is not a call but the outcome OF one, and it is handled on its
 * own before the fallback (see the result branch).
 */
const KNOWN_TOOL_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'tool_use',
  'tool_call',
  'function_call',
  'tool',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function pickReasoning(delta: Record<string, unknown> | null): string | undefined {
  if (!delta) return undefined;
  // The Gate relays chunks verbatim (gate/core/server.mjs relayOpenAiStream
  // writes res.write(data) without rewriting), so whatever field the provider
  // used arrives here — observed as `reasoning`, `reasoning_content`, and
  // `thinking` across backends and models. First non-empty wins.
  for (const key of ['reasoning', 'reasoning_content', 'thinking'] as const) {
    const value = delta[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

export function interpretChatStreamChunk(
  chunk: unknown,
  acc: ChatStreamAcc,
): ChatStreamInterpretation {
  const root = asRecord(chunk);
  if (!root) return { toolCalls: [] };

  if (root.error) {
    const err = asRecord(root.error);
    const reported = typeof err?.message === 'string' ? err.message : undefined;
    const code = typeof err?.code === 'string' ? err.code : 'unknown';
    return {
      toolCalls: [],
      streamError:
        reported && reported.trim()
          ? reported
          : `The gateway reported a failed turn (${code}).`,
    };
  }

  const telemetry = asRecord(root.telemetry);
  if (telemetry?.status === 'degraded') {
    return {
      toolCalls: [],
      telemetryWarning: typeof telemetry.message === 'string' && telemetry.message.trim()
        ? telemetry.message.slice(0, 200)
        : 'Live activity was unavailable for this turn.',
    };
  }

  // A model report rides its own frame (no delta, empty choices) so it can
  // arrive after the text without being mistaken for content.
  const ranModel = typeof root.model === 'string' && root.model ? root.model : undefined;
  const requestedModel =
    typeof root.requested_model === 'string' && root.requested_model ? root.requested_model : undefined;
  const provider = typeof root.provider === 'string' && root.provider ? root.provider : undefined;

  const choice = Array.isArray(root.choices) ? asRecord(root.choices[0]) : null;
  const delta = asRecord(choice?.delta) ?? asRecord(root.delta);
  const toolCalls: ChatToolCall[] = [];
  const text = typeof delta?.content === 'string' && delta.content ? delta.content : undefined;
  let reasoning = pickReasoning(delta);

  const rawTools = delta?.tool_calls ?? delta?.toolCalls;
  if (Array.isArray(rawTools)) {
    for (const entry of rawTools) {
      const item = asRecord(entry);
      if (!item) continue;
      const index = typeof item.index === 'number' ? item.index : 0;
      const slot = `index:${index}`;
      const reportedId = typeof item.id === 'string' && item.id ? item.id : undefined;
      if (reportedId) acc.toolIds.set(index, reportedId);
      // The same slot can carry a second invocation later in the turn (the
      // agent runs a tool, reads its result, runs it again). A changed id is
      // that second call: it must not inherit the first one's name, arguments,
      // detail or terminal status.
      const id = acc.toolIds.get(index);
      const previousId = acc.slotCallIds.get(slot);
      if (id && previousId !== undefined && id !== previousId) {
        acc.toolNames.delete(index);
        acc.toolArgs.delete(index);
        acc.toolDetails.delete(index);
      }
      if (id) acc.slotCallIds.set(slot, id);
      const fn = asRecord(item.function);
      const namePart =
        (typeof fn?.name === 'string' && fn.name) ||
        (typeof item.name === 'string' && item.name) ||
        '';
      const status = resolveToolStatus(acc, slot, item.status, id);
      if (namePart) {
        acc.toolNames.set(index, status === 'running'
          ? (acc.toolNames.get(index) ?? '') + namePart
          : namePart);
      }
      const argsPart = typeof fn?.arguments === 'string' ? fn.arguments : '';
      if (argsPart) acc.toolArgs.set(index, (acc.toolArgs.get(index) ?? '') + argsPart);
      if (typeof item.detail === 'string') acc.toolDetails.set(index, item.detail);
      const name = acc.toolNames.get(index);
      if (!name) continue;
      if (id) acc.namesById.set(id, name);
      const detail = acc.toolDetails.get(index) ?? acc.toolArgs.get(index);
      const durationMs = typeof item.durationMs === 'number' && Number.isFinite(item.durationMs)
        ? item.durationMs : undefined;
      toolCalls.push({
        ...(id ? { id } : {}), name, status, detail,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    }
  }

  if (Array.isArray(delta?.content)) {
    for (const block of delta.content) {
      const item = asRecord(block);
      if (!item) continue;
      const blockType = typeof item.type === 'string' ? item.type : undefined;
      if (blockType === 'thinking' || blockType === 'reasoning') {
        const thought = typeof item.thinking === 'string' ? item.thinking
          : typeof item.text === 'string' ? item.text : '';
        if (thought) reasoning = `${reasoning ?? ''}${thought}`;
        continue;
      }
      if (blockType === 'tool_result') {
        // A tool's own outcome. The result is the only honest evidence that the
        // call failed: the call frame that opened it says `running` and the turn
        // finalizes leftovers as `complete`, so without reading this a failed
        // shell command settled to "Done". Nothing is inferred from an exit
        // code the result does not carry — `readToolResult` reads the payload.
        const callId =
          (typeof item.tool_use_id === 'string' && item.tool_use_id) ||
          (typeof item.id === 'string' && item.id) ||
          '';
        const name = callId ? acc.namesById.get(callId) : undefined;
        // A result for a call this stream never announced cannot update a card.
        if (!callId || !name) continue;
        const verdict = readToolResult(item);
        toolCalls.push({
          id: callId,
          name,
          status: verdict.failed ? 'error' : 'complete',
          ...(verdict.detail ? { detail: verdict.detail.slice(-2000) } : {}),
        });
        continue;
      }
      if (blockType === undefined || !KNOWN_TOOL_BLOCK_TYPES.has(blockType)) {
        // A block kind no provider has sent before. The Gate relays chunks
        // verbatim, so this is how a future tool-call shape first arrives —
        // surface it when it carries tool-call fields instead of dropping
        // it, loudly in dev so the new kind earns a first-class case.
        // Content blocks (`text`, `thinking`, …) carry no name and stay silent.
        const fallbackFn = asRecord(item.function);
        const fallbackName =
          (typeof item.name === 'string' && item.name) ||
          (typeof fallbackFn?.name === 'string' && fallbackFn.name) ||
          '';
        if (!fallbackName) continue;
        if (typeof __DEV__ === 'undefined' || __DEV__) {
          console.warn(
            `[chat-stream-delta] unknown content block type "${blockType ?? 'absent'}" ` +
              `carried a tool call for "${fallbackName}" — treating it as a tool call.`,
          );
        }
        const fallbackKey = `block:${fallbackName}`;
        const fallbackId = typeof item.id === 'string' && item.id ? item.id : undefined;
        if (fallbackId) {
          acc.slotCallIds.set(fallbackKey, fallbackId);
          acc.namesById.set(fallbackId, fallbackName);
        }
        toolCalls.push({
          ...(fallbackId ? { id: fallbackId } : {}),
          name: fallbackName,
          status: resolveToolStatus(acc, fallbackKey, item.status, fallbackId),
        });
        continue;
      }
      // Review fix: the id can arrive in a frame of its own — a block start
      // names the call, and the delta that names the tool follows — so it is
      // remembered per slot BEFORE the name check. Recorded only inside
      // `if (name)`, a nameless block left the PREVIOUS invocation's id in the
      // slot, and the new call's first named frame was merged into the old
      // card instead of opening its own.
      const reportedId =
        (typeof item.id === 'string' && item.id) ||
        (typeof item.tool_use_id === 'string' && item.tool_use_id) ||
        undefined;
      if (reportedId && typeof item.index === 'number') {
        acc.blockIds.set(`block-index:${item.index}`, reportedId);
      }
      const fn = asRecord(item.function);
      const name =
        (typeof item.name === 'string' && item.name) ||
        (typeof fn?.name === 'string' && fn.name) ||
        '';
      if (name) {
        // The id is what makes two invocations of the same tool two cards. The
        // start block is usually the only frame that names it, so it is
        // remembered per slot and re-emitted on every later fragment.
        // Without a block index the id is the slot: two calls to one tool must
        // not share the memory of the first one's id.
        const blockKey =
          typeof item.index === 'number'
            ? `block-index:${item.index}`
            : reportedId !== undefined
              ? `block-id:${reportedId}`
              : `block:${name}`;
        if (reportedId) acc.blockIds.set(blockKey, reportedId);
        const id = acc.blockIds.get(blockKey);
        if (id) {
          acc.slotCallIds.set(blockKey, id);
          acc.namesById.set(id, name);
        }
        toolCalls.push({
          ...(id ? { id } : {}),
          name,
          status: resolveToolStatus(acc, blockKey, item.status, id),
        });
      }
    }
  }

  return { text, reasoning, toolCalls, ranModel, requestedModel, provider };
}
