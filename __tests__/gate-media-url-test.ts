import { mediaSocketUrl } from '@/lib/voice/gate-media-url';

describe('the Gate media socket URL', () => {
  test('rewrites http to ws on the same host and port', () => {
    expect(mediaSocketUrl('http://ethanspc.tail3a1a8a.ts.net:8760', '/v1/voice/stream')).toBe(
      'ws://ethanspc.tail3a1a8a.ts.net:8760/v1/voice/stream',
    );
  });

  test('rewrites https to wss and never to ws', () => {
    expect(mediaSocketUrl('https://ethanspc.tail3a1a8a.ts.net:8760', '/v1/voice/stream')).toBe(
      'wss://ethanspc.tail3a1a8a.ts.net:8760/v1/voice/stream',
    );
    expect(mediaSocketUrl('https://ethanspc.tail3a1a8a.ts.net:8760', '/v1/voice/stream')).not.toMatch(
      /^ws:/,
    );
  });

  test('keeps an IPv4 base on the same scheme family', () => {
    expect(mediaSocketUrl('http://100.95.137.83:8760/', '/v1/voice/stream')).toBe(
      'ws://100.95.137.83:8760/v1/voice/stream',
    );
  });
});
