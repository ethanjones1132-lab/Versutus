import type { ChatMessage } from '@/lib/gateway/types';

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

export function historyToChatMessages(messages: unknown[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue;
    const message = entry as {
      role?: string;
      content?: unknown;
      timestamp?: number;
      __openclaw?: { id?: string };
    };
    const role = message.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    const text = extractMessageText(message.content).trim();
    if (!text) continue;
    const id =
      typeof message.__openclaw?.id === 'string'
        ? message.__openclaw.id
        : `${role}-${message.timestamp ?? result.length}`;
    result.push({
      id,
      role,
      text,
      timestamp: message.timestamp,
    });
  }
  return result;
}

export function createMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}