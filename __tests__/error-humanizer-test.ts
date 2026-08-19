import { GatewayHttpError } from '@/lib/gateway/errors';
import { describeGatewayError, humanizeGatewayError, parseStructuredError } from '@/lib/gateway/error-humanizer';

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
