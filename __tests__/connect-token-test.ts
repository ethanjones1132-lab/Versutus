import { connectToken } from '../src/lib/gateway/connect-token';

describe('connectToken — pair-granted token beats the stale closure value', () => {
  it('uses the freshly granted token when the entered field is empty', () => {
    expect(connectToken('device-token-abc', '')).toBe('device-token-abc');
  });

  it('uses the freshly granted token even when a key was entered (fresh issuance wins)', () => {
    expect(connectToken('device-token-abc', 'setup-key')).toBe('device-token-abc');
  });

  it('falls back to the entered key when no grant happened', () => {
    expect(connectToken(undefined, 'setup-key')).toBe('setup-key');
  });

  it('return undefined when neither a grant nor an entered key exists', () => {
    expect(connectToken(undefined, '')).toBeUndefined();
    expect(connectToken('', undefined)).toBeUndefined();
  });

  it('trims whitespace around both inputs', () => {
    expect(connectToken('  tok  ', '')).toBe('tok');
    expect(connectToken(undefined, '  key  ')).toBe('key');
  });
});