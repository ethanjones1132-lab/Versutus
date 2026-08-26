import type { ConnectionStatus } from '@/lib/gateway/types';

export type ComposerCopyInput = {
  canSend: boolean;
  isStreaming: boolean;
  status: ConnectionStatus;
};

export type ComposerCopy = {
  placeholder: string;
  sendLabel: string;
};

/**
 * Placeholder and send label for the chat composer.
 *
 * A tap while not connected still queues (`queueOfflineInput`) whenever a
 * gateway profile exists. The copy has to say that up front — the Queued
 * badge only appears after the line is already on the thread.
 */
export function composerCopy(input: ComposerCopyInput): ComposerCopy {
  const queues = input.canSend && input.status !== 'connected';
  return {
    placeholder: placeholderCopy({ canSend: input.canSend, queues }),
    sendLabel: sendLabelCopy({ isStreaming: input.isStreaming, queues }),
  };
}

function placeholderCopy(input: { canSend: boolean; queues: boolean }): string {
  if (input.queues) return 'Message will queue';
  if (!input.canSend) return 'Connect a gateway to chat';
  return 'Message or /command';
}

function sendLabelCopy(input: { isStreaming: boolean; queues: boolean }): string {
  if (input.isStreaming) return 'Stop streaming';
  if (input.queues) return 'Queue message';
  return 'Send message';
}
