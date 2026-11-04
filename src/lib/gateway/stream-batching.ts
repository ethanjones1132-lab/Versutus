// ─── Stream batching for chat transcript updates ────────────────
//
// Fast models emit dozens of SSE `data:` lines per second. Calling
// `setMessages` per chunk triggers a FlatList identity change,
// onContentSizeChange scroll, and a full MarkdownText re-parse inside
// MessageBubble on every chunk. Coalescing deltas to at most one
// React state write per animation frame removes the jank without
// changing what the operator eventually sees.
//
// The batcher is a tiny buffer: callers queue text / reasoning / tool
// deltas as they arrive, and a single scheduled flush applies them
// together with one `setMessages` call. `schedule` defaults to
// `requestAnimationFrame` and falls back to a 16ms timeout when RAF
// is absent (Jest / node). Callers may inject a custom scheduler for
// deterministic tests.

import { appendReasoningDelta, appendStreamDelta, appendToolCallDelta } from '@/lib/gateway/message-reducer';
import type { ChatMessage, ChatToolCall } from '@/lib/gateway/types';

export const STREAM_BATCH_MS = 16;

/** One kind of content in arrival order inside a batch. */
export type StreamBatchOp = 'text' | 'reasoning' | 'tool';

export type StreamBatch = {
  text: string;
  reasoning: string;
  tools: ChatToolCall[];
  /**
   * The order the kinds arrived in, with repeats collapsed into one entry.
   *
   * A flush used to apply text, then reasoning, then tools — a fixed order that
   * is only right when the turn happens to arrive that way. A turn that calls a
   * tool and then writes the answer is the common shape, and applying its text
   * first placed the activity block after words it never followed. The reducer
   * anchors the block at the text length it sees, so the order this list is
   * drained in is what the transcript renders.
   */
  order: StreamBatchOp[];
  /**
   * The words of each `order` entry: a text or reasoning entry owns only the
   * chunk that arrived in its own run, so a turn that writes, calls a tool and
   * writes again applies each sentence once, on its own side of the tool.
   * Tool entries carry an empty string (their payload is in `tools`).
   */
  chunks: string[];
};

export function createStreamBatch(): StreamBatch {
  return { text: '', reasoning: '', tools: [], order: [], chunks: [] };
}

export function isBatchEmpty(batch: StreamBatch): boolean {
  return !batch.text && !batch.reasoning && batch.tools.length === 0;
}

/**
 * Coalesce many `append*Delta` applications into at most one `setMessages`
 * per frame. The batcher owns one pending `StreamBatch`; callers queue
 * into it and the next frame drains it with a single reducer pass.
 *
 * A custom `schedule` / `cancel` pair may be supplied for tests.
 */
export function createStreamBatcher(options: {
  runId: string;
  setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  schedule?: (cb: () => void) => number;
  cancel?: (id: number) => void;
}): {
  queueDelta: (delta: string) => void;
  queueReasoning: (reasoning: string) => void;
  queueTool: (tool: ChatToolCall) => void;
  flush: () => void;
  cancel: () => void;
  /** For tests: how many flushes have been applied. */
  readonly flushCount: number;
  /** For tests: inspect without draining. */
  readonly pending: StreamBatch;
} {
  const { runId, setMessages } = options;
  const batch: StreamBatch = createStreamBatch();
  let frame: number | null = null;
  let flushCount = 0;

  const scheduleFn =
    options.schedule ??
    ((cb: () => void): number => {
      if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb) as unknown as number;
      return setTimeout(cb, STREAM_BATCH_MS) as unknown as number;
    });

  const cancelFn =
    options.cancel ??
    ((id: number): void => {
      if (typeof cancelAnimationFrame === 'function') {
        try {
          cancelAnimationFrame(id as unknown as number);
          return;
        } catch {
          // fall through to clearTimeout
        }
      }
      clearTimeout(id as unknown as number);
    });

  const doFlush = (): void => {
    frame = null;
    if (isBatchEmpty(batch)) return;
    const snapshot: StreamBatch = {
      text: batch.text,
      reasoning: batch.reasoning,
      tools: [...batch.tools],
      order: [...batch.order],
      chunks: [...batch.chunks],
    };
    batch.text = '';
    batch.reasoning = '';
    batch.tools.length = 0;
    batch.order.length = 0;
    batch.chunks.length = 0;
    flushCount += 1;
    setMessages((prev) => {
      let next = prev;
      // Drain in arrival order: the reducer anchors the activity block at the
      // text length it sees, so text queued before a tool must be applied
      // before it and text queued after must be applied after it. The tool
      // cursor lives inside the updater because React may run the updater more
      // than once for one commit, and a cursor outside it would go stale.
      let toolIndex = 0;
      for (let at = 0; at < snapshot.order.length; at += 1) {
        const op = snapshot.order[at];
        if (op === 'text') {
          next = appendStreamDelta(next, runId, snapshot.chunks[at]);
        } else if (op === 'reasoning') {
          next = appendReasoningDelta(next, runId, snapshot.chunks[at]);
        } else {
          const tool = snapshot.tools[toolIndex];
          toolIndex += 1;
          if (tool) next = appendToolCallDelta(next, runId, tool);
        }
      }
      // Belt and braces: a tool is never lost because the order list is shorter
      // than the tool list (it cannot be while `arrive` is the only writer, but
      // dropping a card silently is the failure this whole file is about).
      for (; toolIndex < snapshot.tools.length; toolIndex += 1) {
        next = appendToolCallDelta(next, runId, snapshot.tools[toolIndex]);
      }
      return next;
    });
  };

  const schedule = (): void => {
    if (frame !== null) return;
    frame = scheduleFn(doFlush);
  };

  /** Record a kind of arrival; back-to-back words of one kind share an entry that owns all of them. */
  const arrive = (op: StreamBatchOp, chunk = ''): void => {
    const last = batch.order.length - 1;
    // Every tool call is its own entry: two calls in a row are two cards, and each must keep its place among the words.
    if (op !== 'tool' && last >= 0 && batch.order[last] === op) {
      batch.chunks[last] += chunk;
      return;
    }
    batch.order.push(op);
    batch.chunks.push(chunk);
  };

  return {
    queueDelta(delta: string): void {
      if (!delta) return;
      batch.text += delta;
      arrive('text', delta);
      schedule();
    },
    queueReasoning(reasoning: string): void {
      if (!reasoning) return;
      batch.reasoning += reasoning;
      arrive('reasoning', reasoning);
      schedule();
    },
    queueTool(tool: ChatToolCall): void {
      batch.tools.push(tool);
      arrive('tool');
      schedule();
    },
    flush(): void {
      if (frame !== null) {
        cancelFn(frame);
        frame = null;
      }
      doFlush();
    },
    cancel(): void {
      if (frame !== null) {
        cancelFn(frame);
        frame = null;
      }
      batch.text = '';
      batch.reasoning = '';
      batch.tools.length = 0;
      batch.order.length = 0;
      batch.chunks.length = 0;
    },
    get flushCount(): number {
      return flushCount;
    },
    get pending(): StreamBatch {
      return batch;
    },
  };
}
