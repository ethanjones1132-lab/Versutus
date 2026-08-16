import { looksLikeCredential } from '@/lib/gateway/credential-shape';

/**
 * Must stay in step with the Gate's guard in
 * gate/core/capabilities/secrets.mjs — the cases here mirror
 * gate/__tests__/secret-ref-guard.test.mjs deliberately.
 */
describe('looksLikeCredential', () => {
  it.each([
    'sk-Q0f4ioEsl3tE7Hm4ahCvlLIfuPoKxp6OAgXxaoy3mbDP22JR',
    'sk_live_abc123',
    'gsk_abcdef',
    'xai-abcdef',
    'ghp_abcdef',
    'github_pat_11ABCDEFG',
  ])('rejects %s', (value) => {
    expect(looksLikeCredential(value)).toBe(true);
  });

  it('matches a prefix regardless of case', () => {
    expect(looksLikeCredential('SK-ABCDEF')).toBe(true);
  });

  it('rejects a long unbroken token', () => {
    expect(looksLikeCredential('a'.repeat(40))).toBe(true);
  });

  it.each(['my-api-key', 'nvidia/api-key', 'memory.token', 'openai_key', 'k'])(
    'accepts the ordinary ref name %s',
    (value) => {
      expect(looksLikeCredential(value)).toBe(false);
    },
  );

  it('accepts a long name that has separators', () => {
    expect(looksLikeCredential('provider/some-very-long-instance-name/api-key')).toBe(false);
  });

  it('is safe on empty and nullish input', () => {
    expect(looksLikeCredential(undefined)).toBe(false);
    expect(looksLikeCredential(null)).toBe(false);
    expect(looksLikeCredential('')).toBe(false);
  });
});
