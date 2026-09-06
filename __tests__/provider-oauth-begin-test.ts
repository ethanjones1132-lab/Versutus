import { createProviderClient } from '@/lib/gateway/provider-client';
import { resolveOAuthBeginDisplay } from '@/lib/gateway/provider-oauth';

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

describe('resolveOAuthBeginDisplay', () => {
  it('passes the attempt id and authorization URL through trimmed', () => {
    expect(
      resolveOAuthBeginDisplay({
        attemptId: 'attempt-1',
        redirectUri: 'http://localhost:8780/cb',
        authorizationUrl: '  https://vendor.example/authorize?x=1  ',
      }),
    ).toEqual({ attemptId: 'attempt-1', authorizationUrl: 'https://vendor.example/authorize?x=1' });
  });

  it('resolves to null when there is no URL to open', () => {
    expect(resolveOAuthBeginDisplay({ attemptId: 'attempt-1' })).toBeNull();
    expect(
      resolveOAuthBeginDisplay({ attemptId: 'attempt-1', authorizationUrl: '   ' }),
    ).toBeNull();
    expect(resolveOAuthBeginDisplay(null)).toBeNull();
    expect(resolveOAuthBeginDisplay(undefined)).toBeNull();
  });

  it('resolves to null when the attempt id is missing', () => {
    expect(
      resolveOAuthBeginDisplay({ attemptId: '  ', authorizationUrl: 'https://vendor.example/a' }),
    ).toBeNull();
  });
});

describe('provider client beginAuth', () => {
  it('sends providers.auth.begin and returns the begin answer', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const client = createProviderClient(async <T,>(method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return {
        attemptId: 'attempt-9',
        redirectUri: 'http://localhost:8780/cb',
        authorizationUrl: 'https://vendor.example/authorize',
      } as T;
    });
    const answer = await client.beginAuth('anthropic-main');
    expect(calls).toEqual([{ method: 'providers.auth.begin', params: { id: 'anthropic-main' } }]);
    expect(answer.attemptId).toBe('attempt-9');
    expect(answer.authorizationUrl).toBe('https://vendor.example/authorize');
  });
});

test('the Providers section reads the begin answer and refuses honestly', () => {
  const src = readSource(['src', 'components', 'gateway', 'providers-section.tsx']);
  // The answer is read, not discarded: the URL flows into sheet state.
  expect(src).toContain('resolveOAuthBeginDisplay(answer)?.authorizationUrl');
  expect(src).toContain('setOauthUrl');
  // A begin refusal (oauth not configured) surfaces as an error, never the sheet.
  expect(src).toContain("setOauthMessage('')");
  expect(src).not.toContain('void client.beginAuth(snapshot.id);');
});

test('the progress sheet renders the URL with an open-in-browser action', () => {
  const src = readSource(['src', 'components', 'gateway', 'oauth-progress-sheet.tsx']);
  expect(src).toContain('authorizationUrl');
  expect(src).toContain('Open in browser');
  expect(src).toContain('WebBrowser.openBrowserAsync(authorizationUrl)');
  // The fire-and-forget copy stays for Gates that answer without a URL.
  expect(src).toContain('{message}');
});

test('the api-key flow is untouched', () => {
  const src = readSource(['src', 'components', 'gateway', 'providers-section.tsx']);
  expect(src).toContain('onSubmit={(value) => { if (editingId) void saveKey(editingId, value); }}');
  expect(src).toContain('await client.setApiKey(id, value);');
  expect(src).toContain('onSetKey={() => setEditingId(snapshot.id)}');
});
