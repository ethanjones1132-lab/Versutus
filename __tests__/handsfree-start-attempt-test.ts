import { openGateVoiceSession } from '@/lib/voice/handsfree-start-attempt';
import { mediaSocketUrl } from '@/lib/voice/gate-media-url';

const target = {
  label: 'Untitled',
  voiceEngine: 'local',
  surfaceKind: 'bot' as const,
  sessionId: 's1',
  botId: 'hermes',
};

const grant = {
  voiceSessionId: 'vs-1',
  streamPath: '/v1/voice/stream',
  engine: 'local',
};

describe('openGateVoiceSession against a fake Gate', () => {
  test('a ready local engine opens a call even when this phone has no recognizer', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const media: { url: string; token: string; voiceSessionId: string }[] = [];
    const logs: string[] = [];

    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async (method, params) => {
        calls.push({ method, params });
        if (method === 'voice.session.start') return grant;
        return { stopped: true };
      },
      startSession: async () => 'started',
      startGateMedia: async (options) => {
        media.push(options);
        return true;
      },
      log: (event) => logs.push(event.result),
    });

    expect(attempt.result).toBe('started');
    expect(attempt.grant).toEqual(grant);
    expect(calls[0]?.method).toBe('voice.session.start');
    expect(calls[0]?.params.engine).toBe('local');
    expect(calls[0]?.params.deviceId).toBe('phone-abc12345');
    expect(media[0]).toEqual({
      url: mediaSocketUrl('http://127.0.0.1:8760', '/v1/voice/stream'),
      token: 'tok',
      voiceSessionId: 'vs-1',
    });
    expect(logs).toEqual(['started']);
  });

  test('a no_engine refusal is named, not swallowed as unavailable', async () => {
    const error = Object.assign(new Error('The PC voice models are not installed.'), { code: 'no_engine' });
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async () => {
        throw error;
      },
      startGateMedia: async () => true,
      log: () => undefined,
    });
    expect(attempt.result).toBe('no-engine');
    expect(attempt.detail).toMatch(/not installed/);
  });

  test('an incomplete grant is named', async () => {
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async () => ({ voiceSessionId: 'vs-1' }),
      startGateMedia: async () => true,
      log: () => undefined,
    });
    expect(attempt.result).toBe('session-grant-incomplete');
  });

  test('a media failure stops the granted session so the next start is not call-in-progress', async () => {
    const calls: string[] = [];
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async (method) => {
        calls.push(method);
        if (method === 'voice.session.start') return grant;
        return { stopped: true };
      },
      startSession: async () => 'started',
      startGateMedia: async () => false,
      log: () => undefined,
    });
    expect(attempt.result).toBe('media-start-failed');
    expect(calls).toEqual(['voice.session.start', 'voice.session.stop']);
  });

  test('a denied microphone is named and the Gate session is released', async () => {
    const calls: string[] = [];
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async (method) => {
        calls.push(method);
        if (method === 'voice.session.start') return grant;
        return { stopped: true };
      },
      startSession: async () => 'permission-denied',
      startGateMedia: async () => true,
      log: () => undefined,
    });
    expect(attempt.result).toBe('permission-denied');
    expect(calls).toEqual(['voice.session.start', 'voice.session.stop']);
  });

  test('a thread with no session never reaches the media socket', async () => {
    const error = Object.assign(new Error('thread must name a session'), { code: 'invalid_request' });
    let media = 0;
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://127.0.0.1:8760',
      gatewayToken: 'tok',
      target: { ...target, sessionId: '' },
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async () => {
        throw error;
      },
      startGateMedia: async () => {
        media += 1;
        return true;
      },
      log: () => undefined,
    });
    expect(attempt.result).toBe('no-session');
    expect(media).toBe(0);
  });
});
