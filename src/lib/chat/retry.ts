import type { ChatMessage } from '@/lib/gateway/types';

/** Finds the preceding user turn when it has text, attachments, or both. */
export function retryableUserMessage(messages: ChatMessage[]): ChatMessage | undefined {
  const previousUser = [...messages].reverse().find((message) => message.role === 'user');
  if (!previousUser) return undefined;
  return previousUser.text.trim() || (previousUser.attachments?.length ?? 0) > 0
    ? previousUser
    : undefined;
}
