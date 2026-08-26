import { composerCopy } from '@/lib/gateway/composer-copy';
import type { ConnectionStatus } from '@/lib/gateway/types';

const STATUSES: ConnectionStatus[] = [
  'disconnected',
  'connecting',
  'reconnecting',
  'pairing',
  'connected',
];

describe('composerCopy', () => {
  test('connected send still reads as a live send', () => {
    expect(
      composerCopy({ canSend: true, isStreaming: false, status: 'connected' }),
    ).toEqual({
      placeholder: 'Message or /command',
      sendLabel: 'Send message',
    });
  });

  test('disconnected send says the turn will queue', () => {
    expect(
      composerCopy({ canSend: true, isStreaming: false, status: 'disconnected' }),
    ).toEqual({
      placeholder: 'Message will queue',
      sendLabel: 'Queue message',
    });
  });

  test.each(['connecting', 'reconnecting', 'pairing'] as const)(
    '%s still queues, so the composer does not read as a live send',
    (status) => {
      const copy = composerCopy({ canSend: true, isStreaming: false, status });
      expect(copy.placeholder).toBe('Message will queue');
      expect(copy.sendLabel).toBe('Queue message');
    },
  );

  test('no gateway still asks to connect, even when disconnected', () => {
    expect(
      composerCopy({ canSend: false, isStreaming: false, status: 'disconnected' }),
    ).toEqual({
      placeholder: 'Connect a gateway to chat',
      sendLabel: 'Send message',
    });
  });

  test('streaming stop wins over queue copy on the send label', () => {
    expect(
      composerCopy({ canSend: true, isStreaming: true, status: 'disconnected' }).sendLabel,
    ).toBe('Stop streaming');
    expect(
      composerCopy({ canSend: true, isStreaming: true, status: 'connected' }).sendLabel,
    ).toBe('Stop streaming');
  });

  test('every status is classified — connected is live, the rest queue when send is open', () => {
    for (const status of STATUSES) {
      const copy = composerCopy({ canSend: true, isStreaming: false, status });
      if (status === 'connected') {
        expect(copy.sendLabel).toBe('Send message');
      } else {
        expect(copy.sendLabel).toBe('Queue message');
      }
    }
  });
});
