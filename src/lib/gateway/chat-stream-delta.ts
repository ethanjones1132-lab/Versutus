import type { ChatToolCall } from '@/lib/gateway/types';

export type ChatStreamAcc = {
  toolNames: Map<number, string>;
  toolArgs: Map<number, string>;
};

export function createChatStreamAcc(): ChatStreamAcc {
  return { toolNames: new Map(), toolArgs: new Map() };
}

export type ChatStreamInterpretation = {
  text?: string;
  toolCalls: ChatToolCall[];
  streamError?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
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

  const choice = Array.isArray(root.choices) ? asRecord(root.choices[0]) : null;
  const delta = asRecord(choice?.delta) ?? asRecord(root.delta);
  const toolCalls: ChatToolCall[] = [];
  const text = typeof delta?.content === 'string' && delta.content ? delta.content : undefined;

  const rawTools = delta?.tool_calls ?? delta?.toolCalls;
  if (Array.isArray(rawTools)) {
    for (const entry of rawTools) {
      const item = asRecord(entry);
      if (!item) continue;
      const index = typeof item.index === 'number' ? item.index : 0;
      const fn = asRecord(item.function);
      const namePart =
        (typeof fn?.name === 'string' && fn.name) ||
        (typeof item.name === 'string' && item.name) ||
        '';
      if (namePart) acc.toolNames.set(index, (acc.toolNames.get(index) ?? '') + namePart);
      const argsPart = typeof fn?.arguments === 'string' ? fn.arguments : '';
      if (argsPart) acc.toolArgs.set(index, (acc.toolArgs.get(index) ?? '') + argsPart);
      const name = acc.toolNames.get(index);
      if (!name) continue;
      const detail = acc.toolArgs.get(index);
      toolCalls.push({ name, status: 'running', detail });
    }
  }

  if (Array.isArray(delta?.content)) {
    for (const block of delta.content) {
      const item = asRecord(block);
      if (!item) continue;
      if (
        item.type !== 'tool_use' &&
        item.type !== 'tool_call' &&
        item.type !== 'function_call' &&
        item.type !== 'tool'
      ) {
        continue;
      }
      const fn = asRecord(item.function);
      const name =
        (typeof item.name === 'string' && item.name) ||
        (typeof fn?.name === 'string' && fn.name) ||
        '';
      if (name) toolCalls.push({ name, status: 'running' });
    }
  }

  return { text, toolCalls };
}
