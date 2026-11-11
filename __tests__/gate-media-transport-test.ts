import { mediaSocketTransport } from '@/lib/voice/gate-media-url';
import { openGateVoiceSession } from '@/lib/voice/handsfree-start-attempt';
import { handsfreeStartResultCopy } from '@/lib/voice/handsfree-call-copy';

// A hands-free call streams raw audio over the Gate's media socket. The fold
// that turns the gateway's http base into a ws URL has no host check, so the
// only thing standing between a LAN or internet gateway and a plaintext call is
// this policy: wss anywhere, ws only to loopback or the tailnet (bar S1, and
// D2's "no override", not even for a Gate run with --allow-plaintext).

function allows(url: string): boolean {
  return mediaSocketTransport(url).allowed;
}

function refusal(url: string): string {
  const verdict = mediaSocketTransport(url);
  if (verdict.allowed) throw new Error(`${url} was allowed`);
  return verdict.reason;
}

describe('the media socket transport policy', () => {
  test('wss is allowed to any host, because the audio is encrypted in transit', () => {
    expect(mediaSocketTransport('wss://gate.example.com:8760/v1/voice/stream')).toEqual({
      allowed: true,
    });
    expect(allows('wss://203.0.113.9:8760/v1/voice/stream')).toBe(true);
    expect(allows('wss://192.168.1.20:8760/v1/voice/stream')).toBe(true);
    expect(allows('wss://[2001:db8::1]:8760/v1/voice/stream')).toBe(true);
    expect(allows('wss://MY-PC.EXAMPLE.COM:8760/v1/voice/stream')).toBe(true);
  });

  test('an https base gets the same answer as its folded wss socket', () => {
    // `mediaSocketUrl` folds https: to wss:, so a caller may check either form.
    expect(allows('https://gate.example.com:8760')).toBe(true);
    expect(allows('HTTPS://GATE.EXAMPLE.COM:8760')).toBe(true);
  });

  test('ws to loopback is allowed, spelled the ways a gateway is configured', () => {
    expect(allows('ws://localhost:8760/v1/voice/stream')).toBe(true);
    expect(allows('ws://LOCALHOST:8760/v1/voice/stream')).toBe(true);
    expect(allows('WS://LocalHost/v1/voice/stream')).toBe(true);
    expect(allows('ws://127.0.0.1:8760/v1/voice/stream')).toBe(true);
    expect(allows('ws://127.1.2.3:8760/v1/voice/stream')).toBe(true);
    expect(allows('ws://127.255.255.255:8760/v1/voice/stream')).toBe(true);
    // Bracketed IPv6 loopback, with and without a port, in both cases.
    expect(allows('ws://[::1]:8760/v1/voice/stream')).toBe(true);
    expect(allows('ws://[::1]/v1/voice/stream')).toBe(true);
    expect(allows('ws://[0:0:0:0:0:0:0:1]:8760/v1/voice/stream')).toBe(true);
    // And the same host through the gateway base it was folded from.
    expect(allows('http://127.0.0.1:8760')).toBe(true);
  });

  test('ws to a tailnet IPv4 address is allowed across the whole /10', () => {
    expect(allows('ws://100.64.0.1:8760/v1/voice/stream')).toBe(true);
    expect(allows('ws://100.101.102.103:8760/v1/voice/stream')).toBe(true);
    expect(allows('ws://100.127.255.254:8760/v1/voice/stream')).toBe(true);
  });

  test('ws to a tailnet IPv6 address is allowed across fd7a:115c:a1e0::/48', () => {
    expect(allows('ws://[fd7a:115c:a1e0::1]:8760/v1/voice/stream')).toBe(true);
    expect(allows('ws://[FD7A:115C:A1E0::1]:8760/v1/voice/stream')).toBe(true);
    expect(allows('ws://[fd7a:115c:a1e0:0:0:0:0:1]:8760/v1/voice/stream')).toBe(true);
  });

  test('ws to a Tailscale MagicDNS name is allowed, and only a real one', () => {
    expect(allows('ws://my-pc.example.ts.net:8760/v1/voice/stream')).toBe(true);
    expect(allows('ws://MY-PC.EXAMPLE.TS.NET:8760/v1/voice/stream')).toBe(true);
    // A bare zone is not a node, and a `ts.net` label in the middle of someone
    // else's domain is not this tailnet.
    expect(allows('ws://ts.net/v1/voice/stream')).toBe(false);
    expect(allows('ws://notailnet.ts.net.attacker.example/v1/voice/stream')).toBe(false);
    expect(allows('ws://evil-ts.net:8760/v1/voice/stream')).toBe(false);
  });

  test('ws to a LAN or internet host is refused, and says why', () => {
    for (const url of [
      'ws://192.168.1.20:8760/v1/voice/stream',
      'ws://10.0.0.5:8760/v1/voice/stream',
      'ws://172.16.0.9:8760/v1/voice/stream',
      'ws://gate.example.com:8760/v1/voice/stream',
      'ws://203.0.113.9:8760/v1/voice/stream',
      'WS://GATE.EXAMPLE.COM:8760/v1/voice/stream',
      'http://192.168.1.20:8760',
    ]) {
      expect(allows(url)).toBe(false);
      expect(refusal(url)).toMatch(/plaintext/);
    }
  });

  test('a tailnet-looking address just outside the range is refused', () => {
    // 100.64.0.0/10 is 100.64.0.0 through 100.127.255.255, and nothing wider.
    expect(allows('ws://100.63.255.255:8760/v1/voice/stream')).toBe(false);
    expect(allows('ws://100.128.0.1:8760/v1/voice/stream')).toBe(false);
    // fd7a:115c:a1e0::/48 is those three hextets, not their neighbours.
    expect(allows('ws://[fd7a:115c:a1e1::1]:8760/v1/voice/stream')).toBe(false);
    expect(allows('ws://[fd7a:115c::1]:8760/v1/voice/stream')).toBe(false);
    expect(allows('ws://[fd00::1]:8760/v1/voice/stream')).toBe(false);
    expect(allows('ws://[::2]:8760/v1/voice/stream')).toBe(false);
  });

  test('a host cannot be smuggled in as a look-alike or as credentials', () => {
    // A loopback prefix on someone else's domain is a domain, not loopback.
    expect(allows('ws://127.0.0.1.evil.example:8760/v1/voice/stream')).toBe(false);
    expect(allows('ws://localhost.evil.example:8760/v1/voice/stream')).toBe(false);
    // A tailnet name in the user info does not make the host a tailnet host.
    expect(allows('ws://my-pc.example.ts.net@evil.example:8760/v1/voice/stream')).toBe(false);
    // Nor does an out-of-range octet count as loopback or a tailnet address.
    expect(allows('ws://127.0.0.256:8760/v1/voice/stream')).toBe(false);
    expect(allows('ws://100.64.0.999:8760/v1/voice/stream')).toBe(false);
  });

  test('a URL that cannot be read is refused rather than assumed safe', () => {
    for (const url of [
      '',
      '   ',
      'gate.local:8760',
      '/v1/voice/stream',
      'ws://',
      'ws:///v1/voice/stream',
      'ftp://127.0.0.1/v1/voice/stream',
      'ws://[::1:8760/v1/voice/stream',
    ]) {
      expect(allows(url)).toBe(false);
      expect(refusal(url).length).toBeGreaterThan(0);
    }
    expect(refusal('gate.local:8760')).toMatch(/does not name a host/);
    expect(refusal('ftp://127.0.0.1/v1/voice/stream')).toMatch(/not a WebSocket URL/);
  });
});

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

describe('a call never opens a plaintext media socket off this machine', () => {
  test('a LAN gateway is refused before the Gate is asked for a session', async () => {
    const requested: string[] = [];
    const nativeStarts: string[] = [];
    const media: string[] = [];
    const logs: string[] = [];

    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://192.168.1.20:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async (method) => {
        requested.push(method);
        return grant;
      },
      startSession: async (_title, startId): Promise<'started'> => {
        nativeStarts.push(startId);
        return 'started';
      },
      startGateMedia: async (options) => {
        media.push(options.url);
        return true;
      },
      log: (event) => logs.push(event.result),
    });

    expect(attempt.result).toBe('insecure-media-url');
    expect(attempt.detail).toMatch(/plaintext/);
    // Nothing was granted, no microphone was opened, no socket was handed over:
    // the refusal happens before the start, so a retry trips over nothing.
    expect(requested).toEqual([]);
    expect(nativeStarts).toEqual([]);
    expect(media).toEqual([]);
    expect(logs).toEqual(['insecure-media-url']);
  });

  test('an internet gateway over plaintext http is refused too', async () => {
    let requested = 0;
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://gate.example.com:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async () => {
        requested += 1;
        return grant;
      },
      startGateMedia: async () => true,
      log: () => undefined,
    });
    expect(attempt.result).toBe('insecure-media-url');
    expect(requested).toBe(0);
    if (attempt.result === 'started') throw new Error('an insecure call must not start');
    expect(handsfreeStartResultCopy(attempt.result)).toContain(
      'Calls need a secure connection to your gateway. Use HTTPS or Tailscale.',
    );
  });

  test('a tailnet address still opens a ws call', async () => {
    const media: string[] = [];
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'http://100.101.102.103:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async (method) => (method === 'voice.session.start' ? grant : { stopped: true }),
      startSession: async () => 'started',
      startGateMedia: async (options) => {
        media.push(options.url);
        return true;
      },
      log: () => undefined,
    });
    expect(attempt.result).toBe('started');
    expect(media).toEqual(['ws://100.101.102.103:8760/v1/voice/stream?protocol=2']);
  });

  test('an https gateway off the LAN opens a wss call', async () => {
    const media: string[] = [];
    const attempt = await openGateVoiceSession({
      gatewayUrl: 'https://calls.example.com:8760',
      gatewayToken: 'tok',
      target,
      device: { deviceId: 'phone-abc12345' },
      gatewayRequest: async (method) => (method === 'voice.session.start' ? grant : { stopped: true }),
      startSession: async () => 'started',
      startGateMedia: async (options) => {
        media.push(options.url);
        return true;
      },
      log: () => undefined,
    });
    expect(attempt.result).toBe('started');
    expect(media).toEqual(['wss://calls.example.com:8760/v1/voice/stream?protocol=2']);
  });
});

describe('reconnect keeps the transport rule', () => {
  test('a plaintext off-tailnet URL is refused before any socket re-opens', async () => {
    const { reconnectGateMedia } = jest.requireActual('@/lib/voice/gate-reconnect') as typeof import('@/lib/voice/gate-reconnect');
    const startGateMedia = jest.fn(async () => true);
    const ok = await reconnectGateMedia({
      gatewayUrl: 'http://192.168.1.30:8760',
      gatewayToken: 'token',
      grant: { streamPath: '/v1/voice/stream', voiceSessionId: 'vs-1' },
      startGateMedia,
      isAborted: () => false,
      sleep: async () => undefined,
    } as unknown as Parameters<typeof reconnectGateMedia>[0]);
    expect(ok).toBe(false);
    expect(startGateMedia).not.toHaveBeenCalled();
  });
});

describe('parser-confusion URLs fail closed', () => {
  test.each([
    'ws://evil.example\\@127.0.0.1:8760/v1/voice/stream',
    'ws://127.0.0.1\\@evil.example/v1/voice/stream',
    'http://evil.example\\.ts.net/',
    'ws://evil.example 127.0.0.1/',
  ])('%s is refused', (url) => {
    expect(mediaSocketTransport(url).allowed).toBe(false);
  });
});
