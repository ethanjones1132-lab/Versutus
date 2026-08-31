import { getSlashCommandSuggestions } from '@/lib/gateway/slash-commands';

describe('slash palette recents keep their registry danger and live availability', () => {
  test('a destructive recent carries the registry danger instead of the generic local row', () => {
    const suggestions = getSlashCommandSuggestions('/', null, ['/device revoke'], {});
    const row = suggestions.find((item) => item.value === '/device revoke');
    expect(row).toBeDefined();
    expect(row!.danger).toBe('destructive');
    expect(row!.family).toBe('Recent');
    expect(row!.description).toBe('Recent command');
  });

  test('a recent the methods snapshot marks unavailable is flagged unavailable', () => {
    const methods = { 'device-revoke': { available: false, reason: 'not dispatched by this gateway' } };
    const suggestions = getSlashCommandSuggestions('/device revoke', null, ['/device revoke'], methods);
    const row = suggestions.find((item) => item.value === '/device revoke');
    expect(row).toBeDefined();
    expect(row!.unavailable).toBe(true);
  });

  test('a resolved recent the snapshot still advertises stays available', () => {
    const methods = { 'device-revoke': { available: true } };
    const suggestions = getSlashCommandSuggestions('/', null, ['/device revoke'], methods);
    const row = suggestions.find((item) => item.value === '/device revoke');
    expect(row!.unavailable).toBe(false);
  });

  test('an unknown recent keeps the generic row verbatim', () => {
    const suggestions = getSlashCommandSuggestions('/', null, ['/slartibartfast'], {});
    const row = suggestions.find((item) => item.value === '/slartibartfast');
    expect(row).toBeDefined();
    expect(row!.danger).toBe('local');
    expect(row!.unavailable).toBe(false);
  });

  test('a recent resolved by prefix carries the family entry danger and snapshot flag', () => {
    const withSnapshot = getSlashCommandSuggestions('/agents', null, ['/agents 42'], {
      agents: { available: false, reason: 'not dispatched by this gateway' },
    });
    const flagged = withSnapshot.find((item) => item.value === '/agents 42');
    expect(flagged).toBeDefined();
    expect(flagged!.danger).toBe('safe');
    expect(flagged!.unavailable).toBe(true);

    const plain = getSlashCommandSuggestions('/', null, ['/agents 42'], {});
    const kept = plain.find((item) => item.value === '/agents 42');
    expect(kept!.danger).toBe('safe');
    expect(kept!.unavailable).toBe(false);
  });

  test('recents stay first and the decorated recent beats its registry duplicate', () => {
    const suggestions = getSlashCommandSuggestions('/', null, ['/device revoke'], {});
    expect(suggestions[0]?.value).toBe('/device revoke');
    const matches = suggestions.filter((item) => item.value === '/device revoke');
    expect(matches).toHaveLength(1);
    expect(matches[0].family).toBe('Recent');
  });

  test('an unavailable recent is hidden by the live-availability filter', () => {
    const methods = { 'device-revoke': { available: false, reason: 'not dispatched by this gateway' } };
    const suggestions = getSlashCommandSuggestions('/', null, ['/device revoke'], methods);
    expect(suggestions.some((item) => item.value === '/device revoke')).toBe(false);
  });
});