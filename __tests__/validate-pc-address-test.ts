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
    ['host-1.local', 'a mDNS name with a digit in its first label'],
  ])('accepts %s (%s)', (value) => {
    expect(validatePcAddress(value).valid).toBe(true);
  });

  test.each([
    ['100.81.238.109', 'a tailnet IP'],
    ['192.168.1.5', 'a LAN IP'],
    ['100.81.238.109:8760', 'a tailnet IP with a port'],
    ['192.168.1.10:8760', 'a LAN IP with the Gate port'],
  ])('accepts %s (%s)', (value) => {
    expect(validatePcAddress(value).valid).toBe(true);
  });

  // "1.2.3" has no hostname label to be one, but hostnamePattern accepts an
  // all-digit dotted string; the URL parser reads it as 1.2.0.3. Any all-numeric
  // dotted form must be a canonical quad or refused, whatever its part count.
  test.each([
    ['1.2.3', 'three numeric parts, which the URL parser reads as 1.2.0.3'],
    ['1.2.3:8760', 'the same with the Gate port'],
    ['1.2.3.4.5', 'five numeric parts'],
    ['0250.168.0.1', 'a leading-zero octet the parser reinterprets'],
    ['10', 'a bare number is not a hostname either'],
  ])('rejects %s (%s) with the address message', (value) => {
    const verdict = validatePcAddress(value);
    expect(verdict.valid).toBe(false);
    expect(verdict.message).toBe(
      'Use a Tailscale hostname, tailnet IP (100.x.x.x), or LAN IP — optional :port (Gate is 8760).',
    );
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

  // ONB-2: the old check stripped up to five port digits and validated only
  // the HOST, so `100.101.102.103:99999` read "ready" and was saved as
  // `tailscaleHost` — where `new URL` throws, `push` swallows it, and every
  // later wave dropped the same address. The port's RANGE is the gate.
  test.each([
    ['100.101.102.103:1', 'the lowest port a socket can be asked for'],
    ['100.101.102.103:65535', 'the highest port URL parsing accepts'],
    ['studio.tailnet.ts.net:1', 'a one-digit port on a MagicDNS name'],
  ])('accepts %s (%s)', (value) => {
    expect(validatePcAddress(value).valid).toBe(true);
  });

  test.each([
    ['100.101.102.103:0', 'port zero'],
    ['100.101.102.103:65536', 'one past the URL parser ceiling'],
    ['100.101.102.103:99999', 'five digits, unprobeable'],
    ['studio.tailnet.ts.net:70000', 'a MagicDNS name with an unprobeable port'],
  ])('rejects %s (%s) and says so', (value) => {
    const verdict = validatePcAddress(value);
    expect(verdict.valid).toBe(false);
    expect(verdict.message).toBe('Ports go from 1 to 65535.');
  });

  test('a host with no port is judged exactly as before', () => {
    expect(validatePcAddress('100.101.102.103').message).toBe('Looks good — ready to connect.');
    expect(validatePcAddress('studio.tailnet.ts.net:8760').message).toBe(
      'Looks good — ready to connect.',
    );
  });
});
