import type { ConnectionStatus } from '@/lib/gateway/types';

export type ComposerCopyInput = {
  canSend: boolean;
  isStreaming: boolean;
  status: ConnectionStatus;
  queuedCount?: number;
  /**
   * Who the words go to — the Bot's display name. The idle placeholder names
   * them ("Message Forge"); a name too long for one line at 375px falls back
   * to the plain prompt rather than wrapping the pill.
   */
  recipient?: string;
};

/** The longest recipient name the idle placeholder carries on one line. */
const RECIPIENT_MAX = 18;

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
 *
 * Every placeholder stays on one line at 375px — the pill's field shows
 * nothing else on an empty draft — so each is 26 characters or fewer.
 */
export function composerCopy(input: ComposerCopyInput): ComposerCopy {
  const queues = input.canSend && input.status !== 'connected';
  return {
    placeholder: placeholderCopy({
      canSend: input.canSend,
      queues,
      isStreaming: input.isStreaming,
      queuedCount: input.queuedCount,
      recipient: input.recipient,
    }),
    sendLabel: sendLabelCopy({ isStreaming: input.isStreaming, queues }),
  };
}

function placeholderCopy(input: {
  canSend: boolean;
  queues: boolean;
  isStreaming: boolean;
  queuedCount?: number;
  recipient?: string;
}): string {
  if (input.isStreaming && input.queuedCount && input.queuedCount > 0) {
    return input.queuedCount === 1 ? '1 queued — sends next' : `${input.queuedCount} queued — sends in order`;
  }
  if (input.queues) return 'Message will queue';
  if (!input.canSend) return 'Connect a gateway to chat';
  const recipient = input.recipient?.trim();
  if (recipient && recipient.length <= RECIPIENT_MAX) return `Message ${recipient}`;
  // Plain words: the command palette is one tap behind the `+`, so the
  // placeholder no longer advertises slash syntax.
  return 'Ask anything';
}

function sendLabelCopy(input: { isStreaming: boolean; queues: boolean }): string {
  if (input.isStreaming) return 'Stop streaming';
  if (input.queues) return 'Queue message';
  return 'Send message';
}

/** Reload and reconnect already live in overflow (and pull-to-refresh). */
export type ComposerDockUtility = 'browse-commands';

export function composerDockUtilities(input: {
  canBrowseCommands: boolean;
}): ComposerDockUtility[] {
  return input.canBrowseCommands ? ['browse-commands'] : [];
}
