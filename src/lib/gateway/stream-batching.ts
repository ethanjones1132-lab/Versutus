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

export type StreamBatch = {
  text: string;
  reasoning: string;
  tools: ChatToolCall[];
};

export function createStreamBatch(): StreamBatch {
  return { text: '', reasoning: '', tools: [] };
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
    const snapshot: StreamBatch = { text: batch.text, reasoning: batch.reasoning, tools: [...batch.tools] };
    batch.text = '';
    batch.reasoning = '';
    batch.tools.length = 0;
    flushCount += 1;
    setMessages((prev) => {
      let next = prev;
      if (snapshot.text) next = appendStreamDelta(next, runId, snapshot.text);
      if (snapshot.reasoning) next = appendReasoningDelta(next, runId, snapshot.reasoning);
      for (const tool of snapshot.tools) next = appendToolCallDelta(next, runId, tool);
      return next;
    });
  };

  const schedule = (): void => {
    if (frame !== null) return;
    frame = scheduleFn(doFlush);
  };

  return {
    queueDelta(delta: string): void {
      if (!delta) return;
      batch.text += delta;
      schedule();
    },
    queueReasoning(reasoning: string): void {
      if (!reasoning) return;
      batch.reasoning += reasoning;
      schedule();
    },
    queueTool(tool: ChatToolCall): void {
      batch.tools.push(tool);
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
    },
    get flushCount(): number {
      return flushCount;
    },
    get pending(): StreamBatch {
      return batch;
    },
  };
}
