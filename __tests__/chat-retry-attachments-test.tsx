import { retryableUserMessage } from '@/lib/chat/retry';
import type { ChatMessage } from '@/lib/gateway/types';

const image = { kind: 'image', uri: 'data:image/jpeg;base64,AA==', mimeType: 'image/jpeg' } as const;

function turn(text: string, attachments?: ChatMessage['attachments']): ChatMessage {
  return { id: 'user-1', role: 'user', text, timestamp: 1, attachments } as ChatMessage;
}

test('retrying a failed text and image turn retains the exact stored attachment list', () => {
  const attachments = [image];
  const previousUser = retryableUserMessage([
    turn('Describe this', attachments),
    { id: 'failed', role: 'assistant', text: 'Error: interrupted', timestamp: 2 } as ChatMessage,
  ]);

  expect(previousUser?.text).toBe('Describe this');
  expect(previousUser?.attachments).toBe(attachments);
});

test('an image-only user turn is eligible for retry', () => {
  const previousUser = retryableUserMessage([turn('', [image])]);

  expect(previousUser?.text).toBe('');
  expect(previousUser?.attachments).toEqual([image]);
});

test('a text-only user turn remains eligible for retry without attachments', () => {
  const previousUser = retryableUserMessage([turn('Try again')]);

  expect(previousUser?.text).toBe('Try again');
  expect(previousUser?.attachments).toBeUndefined();
});
