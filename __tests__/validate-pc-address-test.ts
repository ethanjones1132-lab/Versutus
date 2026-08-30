import { describe, expect, test } from '@jest/globals';

import { validatePcAddress } from '@/lib/onboarding/validate-pc-address';

// This function had no tests, which is why a local-model commit could reject every
// Tailscale hostname and still pass the gate. The hostname cases below are the
// regression; the out-of-range octets are the fix that commit was actually for.
describe('validatePcAddress', () => {
  test.each([
    ['studio.tailnet.ts.net', 'a tailnet hostname — what onboarding asks for'],
    ['ethans-pc.tail1234.ts.net', 'a hostname with digits and a hyphen'],
    ['studio.tailnet.ts.net:8760', 'a hostname with the Gate port'],
  ])('accepts %s (%s)', (value) => {
    expect(validatePcAddress(value).valid).toBe(true);
  });

  test.each([
    ['100.81.238.109', 'a tailnet IP'],
    ['192.168.1.5', 'a LAN IP'],
    ['100.81.238.109:8760', 'a tailnet IP with a port'],
  ])('accepts %s (%s)', (value) => {
    expect(validatePcAddress(value).valid).toBe(true);
  });

  test.each([
    ['999.999.999.999', 'every octet out of range'],
    ['192.168.1.256', 'one octet out of range'],
    ['300.1.1.1', 'first octet out of range'],
  ])('rejects %s (%s)', (value) => {
    expect(validatePcAddress(value).valid).toBe(false);
  });

  test('rejects an empty address', () => {
    expect(validatePcAddress('   ').valid).toBe(false);
  });

  test('rejects a bare single-label name', () => {
    // No dot: not a hostname by this pattern, not an IP either.
    expect(validatePcAddress('ethanspc').valid).toBe(false);
  });
});
