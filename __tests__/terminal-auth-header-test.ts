import { streamingFetch } from '@/lib/net/streaming-fetch';
import { openTerminalSession } from '@/lib/terminal/client';

jest.mock('@/lib/net/streaming-fetch', () => ({ streamingFetch: jest.fn() }));

const mockStreamingFetch = streamingFetch as jest.Mock;

const handlers = { onOutput: jest.fn(), onError: jest.fn(), onExit: jest.fn() };

/**
 * A gateway token stored with a trailing \r reached OkHttp raw, which refused
 * the request before sending it ("Unexpected char 0x0d at 50 in Authorization
 * value") — the shell never opened while chat, which cleans its header, worked.
 */
describe('terminal stream auth header', () => {
  beforeEach(() => {
    // A refused stream is enough: the header is observed on the call itself.
    mockStreamingFetch.mockReset().mockResolvedValue({ ok: false, status: 401 });
  });

  const sentAuthorization = () => mockStreamingFetch.mock.calls[0][1].headers.Authorization;

  test('a token with a trailing carriage return is sent without it', async () => {
    await expect(openTerminalSession('ws://127.0.0.1:8760', handlers, 'test-gateway-token\r')).rejects.toThrow(
      'Terminal stream failed (401)',
    );
    expect(sentAuthorization()).toBe('Bearer test-gateway-token');
  });

  test('a clean token is sent unchanged', async () => {
    await expect(openTerminalSession('ws://127.0.0.1:8760', handlers, 'test-gateway-token')).rejects.toThrow();
    expect(sentAuthorization()).toBe('Bearer test-gateway-token');
  });

  test('a token that is only whitespace sends no Authorization header', async () => {
    await expect(openTerminalSession('ws://127.0.0.1:8760', handlers, '\r\n')).rejects.toThrow();
    expect(sentAuthorization()).toBeUndefined();
  });
});
