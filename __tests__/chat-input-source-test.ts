import {
  decideCallSend,
  isHandsfreeCallSource,
  routesAsModelText,
} from '@/lib/gateway/chat-input-source';

describe('isHandsfreeCallSource', () => {
  test('names only the call source', () => {
    expect(isHandsfreeCallSource('handsfree-call')).toBe(true);
    expect(isHandsfreeCallSource('composer')).toBe(false);
    expect(isHandsfreeCallSource(undefined)).toBe(false);
  });
});

describe('routesAsModelText', () => {
  test('a call transcript is plain model text, never a command', () => {
    expect(routesAsModelText('handsfree-call')).toBe(true);
    expect(routesAsModelText('composer')).toBe(false);
    expect(routesAsModelText(undefined)).toBe(false);
  });
});

describe('decideCallSend', () => {
  test('an omitted or composer source is never gated here', () => {
    for (const source of [undefined, 'composer'] as const) {
      expect(decideCallSend({ source, connected: false, busy: true })).toBe('send');
    }
  });

  test('a connected, idle call sends', () => {
    expect(decideCallSend({ source: 'handsfree-call', connected: true, busy: false })).toBe('send');
  });

  test('a disconnected call is offline so recovery owns the words', () => {
    expect(decideCallSend({ source: 'handsfree-call', connected: false, busy: false })).toBe(
      'offline',
    );
  });

  test('a call send while a send or stream is in flight is busy, not a hollow sent', () => {
    expect(decideCallSend({ source: 'handsfree-call', connected: true, busy: true })).toBe('busy');
  });

  test('offline wins over busy so the recovery answer cannot depend on an unrelated stream', () => {
    expect(decideCallSend({ source: 'handsfree-call', connected: false, busy: true })).toBe(
      'offline',
    );
  });
});
