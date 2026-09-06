import { createProviderClient } from '@/lib/gateway/provider-client';
import {
  isOAuthAttemptPollUnsupported,
  isUnknownOAuthAttempt,
  OAUTH_ATTEMPT_POLL_MS,
  oauthAttemptExpired,
} from '@/lib/gateway/provider-oauth';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('oauthAttemptExpired', () => {
  it('reports expired once the budget has run out', () => {
    expect(
      oauthAttemptExpired({ id: 'a', providerId: 'p', expiresAt: 1000 }, 1000),
    ).toBe(true);
    expect(
      oauthAttemptExpired({ id: 'a', providerId: 'p', expiresAt: 999 }, 1000),
    ).toBe(true);
  });

  it('keeps waiting while the budget holds', () => {
    expect(
      oauthAttemptExpired({ id: 'a', providerId: 'p', expiresAt: 1001 }, 1000),
    ).toBe(false);
  });

  it('never expires on a missing or malformed read', () => {
    expect(oauthAttemptExpired(null, 1000)).toBe(false);
    expect(oauthAttemptExpired(undefined, 1000)).toBe(false);
    expect(
      oauthAttemptExpired({ id: 'a', providerId: 'p', expiresAt: 'soon' } as never, 1000),
    ).toBe(false);
  });
});

describe('attempt read failures', () => {
  it('treats unknown attempt as the attempt being gone', () => {
    expect(isUnknownOAuthAttempt(new Error('unknown attempt'))).toBe(true);
    expect(isUnknownOAuthAttempt(new Error('boom'))).toBe(false);
  });

  it('treats an unanswerable attempt read as polling unavailable', () => {
    expect(
      isOAuthAttemptPollUnsupported(new Error('Unknown method "providers.auth.attempt.get"')),
    ).toBe(true);
    expect(
      isOAuthAttemptPollUnsupported(
        new Error('providers.auth.attempt.get is not supported by this gateway.'),
      ),
    ).toBe(true);
    expect(isOAuthAttemptPollUnsupported(new Error('boom'))).toBe(false);
  });

  it('polls on a shared interval', () => {
    expect(OAUTH_ATTEMPT_POLL_MS).toBe(3000);
  });
});

describe('provider client authAttempt', () => {
  it('sends providers.auth.attempt.get and returns the live attempt', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const client = createProviderClient(async <T,>(method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return { id: 'attempt-1', providerId: 'anthropic-main', expiresAt: 9999 } as T;
    });
    const attempt = await client.authAttempt('attempt-1');
    expect(calls).toEqual([
      { method: 'providers.auth.attempt.get', params: { attemptId: 'attempt-1' } },
    ]);
    expect(attempt.providerId).toBe('anthropic-main');
  });
});

test('the Providers section polls the attempt until it resolves, then reloads', () => {
  const src = readSource(['src', 'components', 'gateway', 'providers-section.tsx']);
  // The poll reads the new client method on the shared interval.
  expect(src).toContain('client.authAttempt(attemptId)');
  expect(src).toContain('OAUTH_ATTEMPT_POLL_MS');
  // Completion (attempt gone) and expiry both reload providers and name the outcome.
  expect(src).toContain('Authorization finished. Providers reloaded.');
  expect(src).toContain('Authorization expired before it completed. Try again.');
  expect(src).toContain('oauthAttemptExpired(attempt)');
  expect(src).toContain('isUnknownOAuthAttempt(caught)');
  // An undispatched attempt read stops polling without an error surface.
  expect(src).toContain('isOAuthAttemptPollUnsupported(caught)');
});

test('the begin-URL half still works when polling never starts', () => {
  const src = readSource(['src', 'components', 'gateway', 'providers-section.tsx']);
  // The URL still flows into the sheet exactly as before.
  expect(src).toContain('resolveOAuthBeginDisplay(answer)');
  expect(src).toContain("setOauthMessage('Continue authorization in the desktop browser.')");
  // No attempt id means no poll: a begin answer with nothing to open leaves
  // the fire-and-forget copy alone.
  expect(src).toContain('setOauthAttemptId(display?.attemptId ?? null)');
  // Closing the sheet stops the poll.
  expect(src).toContain('setOauthAttemptId(null)');
  // A begin refusal still surfaces as an error, never the sheet.
  expect(src).toContain("setOauthMessage('')");
});
