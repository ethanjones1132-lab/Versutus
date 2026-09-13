import { handsfreeStartBlocker, handsfreeStartBlockerCopy } from '@/lib/voice/handsfree-start-policy';

const clear = { status: 'connected', isSending: false, isCommandRunning: false, pendingApproval: false };

describe('handsfreeStartBlocker', () => {
  test('nothing blocks a connected, idle thread', () => {
    expect(handsfreeStartBlocker(clear)).toBeNull();
  });

  test('names the one thing in the way, disconnection first', () => {
    expect(handsfreeStartBlocker({ ...clear, status: 'reconnecting', isSending: true })).toBe('disconnected');
    expect(handsfreeStartBlocker({ ...clear, pendingApproval: true, isSending: true })).toBe('approval');
    expect(handsfreeStartBlocker({ ...clear, isCommandRunning: true })).toBe('command');
    expect(handsfreeStartBlocker({ ...clear, isSending: true })).toBe('streaming');
  });

  test('every blocker has its own sentence', () => {
    const copy = (['disconnected', 'approval', 'command', 'streaming'] as const).map(handsfreeStartBlockerCopy);
    expect(new Set(copy).size).toBe(4);
    expect(handsfreeStartBlockerCopy('streaming')).toBe('Wait for this reply to finish, or stop it, then start the call.');
  });
});
