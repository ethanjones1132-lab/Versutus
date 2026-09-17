import { GatewayHttpError } from '@/lib/gateway/errors';
import { describeGatewayError, errorBannerButton, humanizeGatewayError, parseStructuredError } from '@/lib/gateway/error-humanizer';

describe('humanizeGatewayError', () => {
  it('maps user abort to dismissible cancelled', () => {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    const result = humanizeGatewayError(error);
    expect(result.title).toBe('Cancelled');
    expect(result.action).toBe('dismiss');
  });

  it('maps auth rejection to setup action', () => {
    const result = humanizeGatewayError(new GatewayHttpError('invalid api key', 401));
    expect(result.title).toBe('Gateway rejected the key');
    expect(result.action).toBe('setup');
  });

  it('maps token-required message to setup action', () => {
    const result = humanizeGatewayError(new Error('setup token required'));
    expect(result.title).toBe('Setup token required');
    expect(result.action).toBe('setup');
  });

  it('maps an unparseable gateway address to an entry-mistake verdict, not a network error', () => {
    const result = humanizeGatewayError(
      new Error(
        'Invalid gateway URL: "http://" does not parse — include host and port, e.g. http://yourpc.tailnet.ts.net:8760',
      ),
    );
    expect(result.title).toBe('Gateway address looks wrong');
    expect(result.affected).toBe('gateway address');
    expect(result.action).toBe('dismiss'); // nothing to reconnect — fix the text
    expect(result.cause).toContain('include host and port');
  });

  it('maps network failures to reconnect action', () => {
    const result = humanizeGatewayError(new Error('Network request failed'));
    expect(result.title).toBe('Could not reach the gateway');
    expect(result.action).toBe('reconnect');
  });

  it('maps generic gateway HTTP errors to reconnect action', () => {
    const result = humanizeGatewayError(new GatewayHttpError('internal server error', 500));
    expect(result.title).toBe('Gateway error 500');
    expect(result.action).toBe('reconnect');
  });

  it('does not treat "aborted by peer" as a user abort', () => {
    const result = humanizeGatewayError(new Error('connection aborted by peer'));
    expect(result.action).not.toBe('dismiss');
  });

  it('maps a Bot-routing refusal to the desktop-parity verdict, not a network error', () => {
    const gate = 'bot "echo" still uses the default listen key; /p/echo/ rejects it — give the profile its own API_SERVER_KEY';
    const result = humanizeGatewayError(new GatewayHttpError(gate, 409));
    expect(result.title).toBe('Bot listen key refused');
    expect(result.affected).toBe('bot routing');
    expect(result.action).toBe('copy'); // nothing on the phone fixes this — host-side
    expect(result.cause).toContain('/p/echo/ rejects it');
  });

  it('maps an unreachable CLI environment to a remote-task verdict', () => {
    const result = humanizeGatewayError(
      new Error('hermes server exited with code 1 before becoming reachable.'),
    );
    expect(result.title).toBe('Environment unreachable');
    expect(result.affected).toBe('remote task');
    expect(result.action).not.toBe('reconnect'); // not the gateway transport's fault
  });

  it('keeps generic HTTP failures on the existing reconnect path', () => {
    const result = humanizeGatewayError(new GatewayHttpError('upstream exploded', 502));
    expect(result.title).toBe('Gateway error 502');
    expect(result.action).toBe('reconnect');
  });

  it('maps an empty turn to a model-did-not-answer verdict, not a connection fault', () => {
    const result = humanizeGatewayError(
      new Error('The backend completed the turn with no assistant content.'),
    );
    expect(result.title).toBe('The model did not answer');
    expect(result.affected).toBe('this turn');
    expect(result.action).toBe('copy');
    expect(result.next).toMatch(/signed-in provider/);
  });
});

describe('chat routing refusals', () => {
  const refusals = [
    {
      message: 'This chat names no Bot, backend or model, so the Gate has nowhere to send it. Open a Bot or pick a model.',
      status: 400,
      title: 'Choose where to chat',
      next: /Open a Bot.*pick a model/,
    },
    {
      message: 'Model "network-401" is declared by multiple providers',
      status: 409,
      title: 'Choose a provider for this model',
      next: /model picker.*provider/,
    },
    {
      message: 'No provider declares model "network-401"',
      status: 404,
      title: 'Model unavailable',
      next: /model picker.*available model/,
    },
    {
      message: 'model "network-401" not found on provider "test-provider"',
      status: 502,
      title: 'Model unavailable',
      next: /model picker.*available model/,
    },
    {
      message: 'Unknown provider "network-401"',
      status: 404,
      title: 'Provider unavailable',
      next: /another provider/,
    },
    {
      message: 'Provider "network-401" does not support streaming',
      status: 400,
      title: 'Streaming unavailable for this provider',
      next: /provider that supports streaming/,
    },
    {
      message: 'This backend does not implement bots',
      status: 501,
      title: 'Capability unavailable',
      next: /CLI environment.*supports/,
    },
    {
      message: 'Backend "network-401" does not implement runs',
      status: 501,
      title: 'Capability unavailable',
      next: /CLI environment.*supports/,
    },
  ];

  it.each(refusals)('$message names a routing fix, not a reconnect', ({ message, status, title, next }) => {
    for (const error of [message, new Error(message), new GatewayHttpError(message, status)]) {
      const result = humanizeGatewayError(error);
      expect(result.title).toBe(title);
      expect(result.cause).toBe(message);
      expect(result.affected).not.toBe('gateway connection');
      expect(result.next).toMatch(next);
      expect(result.action).toBe('dismiss');
    }
  });

  it.each(['chat failed: 401', 'local provider chat failed: 403'])('%s never requests a Gateway listen key change', (message) => {
    const result = humanizeGatewayError(new GatewayHttpError(message, 401));
    expect(result.title).toBe('Model provider refused the request');
    expect(result.action).toBe('dismiss');
    expect(result.next).not.toMatch(/token|listen key|gateway setup/i);
  });

  it.each(['Network request failed', 'connection refused', 'model catalog fetch timed out'])('%s keeps the reconnect action', (message) => {
    expect(humanizeGatewayError(new GatewayHttpError(message, 502)).action).toBe('reconnect');
  });
});

describe('errorBannerButton', () => {
  it('opens gateway setup when the verdict is setup, not reconnect', () => {
    const verdict = humanizeGatewayError(new GatewayHttpError('invalid api key', 401));
    expect(errorBannerButton(verdict.action)).toEqual({
      kind: 'setup',
      label: 'Open gateway setup',
    });
  });

  it('reconnects when the verdict is a reachability miss', () => {
    const verdict = humanizeGatewayError(new Error('Network request failed'));
    expect(errorBannerButton(verdict.action)).toEqual({
      kind: 'reconnect',
      label: 'Reconnect gateway',
    });
  });

  it('copies details when the verdict is host-side, not reconnect', () => {
    const gate =
      'bot "echo" still uses the default listen key; /p/echo/ rejects it — give the profile its own API_SERVER_KEY';
    const verdict = humanizeGatewayError(new GatewayHttpError(gate, 409));
    expect(errorBannerButton(verdict.action)).toEqual({
      kind: 'copy',
      label: 'Copy details',
    });
  });

  it('hides the button when the verdict is dismiss', () => {
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    expect(errorBannerButton(humanizeGatewayError(abort).action)).toEqual({ kind: 'dismiss' });
  });
});

describe('parseStructuredError', () => {
  it('extracts Cause, Affected, and Next lines', () => {
    const text = 'Cause: timeout. Affected: gateway connection. Next: retry.';
    expect(parseStructuredError(text)).toEqual({
      cause: 'timeout.',
      affected: 'gateway connection.',
      next: 'retry.',
    });
  });

  it('falls back to the whole message when no structure is present', () => {
    expect(parseStructuredError('plain error')).toEqual({ cause: 'plain error' });
  });
});

describe('describeGatewayError', () => {
  it('joins cause and next into one sentence', () => {
    const result = describeGatewayError(new Error('Failed to fetch'));
    expect(result).toContain('Failed to fetch');
    expect(result).toContain('Check that the gateway is running');
  });

  it('never emits the Cause/Affected/Next dev-speak it replaced', () => {
    const result = describeGatewayError(new Error('getaddrinfo ENOTFOUND host'));
    expect(result).not.toMatch(/Cause:|Affected:|Next:/);
  });

  it('returns cause alone when there is no next step', () => {
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    expect(describeGatewayError(abort)).toBe('You cancelled the request.');
  });

  it('does not double up terminal punctuation', () => {
    const result = describeGatewayError(new Error('Connection refused.'));
    expect(result).not.toContain('.. ');
  });

  it('adds a separator when the cause has no terminal punctuation', () => {
    const result = describeGatewayError(new Error('Connection refused'));
    expect(result).toContain('Connection refused. ');
  });

  it('handles a non-Error value without throwing', () => {
    expect(typeof describeGatewayError('plain string failure')).toBe('string');
    expect(describeGatewayError(undefined).length).toBeGreaterThan(0);
  });
});

describe('a refusal is attributed to whoever refused', () => {
  // 2026-09-16: "chat failed: 401" is a MODEL PROVIDER refusing the Gate's call
  // upstream. The app read any 401 as the gateway token and said "Open gateway
  // setup and update the token" — sending the operator to replace a token that
  // was working.
  test("a provider's upstream refusal is not the gateway token", () => {
    const providerRefusal = new GatewayHttpError('chat failed: 401', 401);
    const result = humanizeGatewayError(providerRefusal);
    expect(result.title).not.toBe('Gateway rejected the key');
    expect(result.affected).not.toBe('gateway connection');
    expect(result.cause).toMatch(/model provider/i);
    expect(result.action).not.toBe('setup');
    expect(humanizeGatewayError(new Error('chat failed: 403')).cause).toMatch(/model provider/i);
  });

  test("the Gate's own refusal of its token still reads as the gateway key", () => {
    const gateRefusal = new GatewayHttpError('Bearer token required', 401);
    expect(humanizeGatewayError(gateRefusal).title).toBe('Gateway rejected the key');
  });
});
