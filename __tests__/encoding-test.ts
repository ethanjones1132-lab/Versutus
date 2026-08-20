import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  utf8Encode,
} from '@/lib/encoding';

/**
 * These stand in for btoa/atob/TextEncoder, which React Native and Expo do not
 * install — so they are on the device-pairing and request-signing path. Node's
 * Buffer is the oracle: if these disagree with it, a signature computed on the
 * phone will not verify on the Gate.
 */
// Jest runs on Node, but the app's tsconfig has no node types — declare just
// the surface used as the oracle rather than widening the app's type surface.
declare const Buffer: {
  from(input: string | Uint8Array | ArrayLike<number>, encoding?: string): Uint8Array & {
    toString(encoding: string): string;
  };
};

const oracleB64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

describe('base64', () => {
  const cases: [string, Uint8Array][] = [
    ['empty', new Uint8Array([])],
    ['one byte', new Uint8Array([0])],
    ['two bytes (one pad)', new Uint8Array([255, 128])],
    ['three bytes (no pad)', new Uint8Array([1, 2, 3])],
    ['all byte values', new Uint8Array(Array.from({ length: 256 }, (_, i) => i))],
  ];

  test.each(cases)('encodes %s exactly as Buffer does', (_name, bytes) => {
    expect(bytesToBase64(bytes)).toBe(oracleB64(bytes));
  });

  test.each(cases)('round-trips %s', (_name, bytes) => {
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  test('decodes what Buffer encoded', () => {
    const bytes = new Uint8Array([9, 250, 3, 77, 0, 1]);
    expect(Array.from(base64ToBytes(oracleB64(bytes)))).toEqual(Array.from(bytes));
  });

  test('accepts unpadded and URL-safe input', () => {
    const bytes = new Uint8Array([251, 255, 190, 255]);
    const urlSafe = bytesToBase64Url(bytes);
    expect(urlSafe).not.toContain('+');
    expect(urlSafe).not.toContain('/');
    expect(urlSafe).not.toContain('=');
    expect(Array.from(base64UrlToBytes(urlSafe))).toEqual(Array.from(bytes));
  });

  test('ignores whitespace rather than corrupting the output', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const wrapped = bytesToBase64(bytes).replace(/(.{4})/g, '$1\n');
    expect(Array.from(base64ToBytes(wrapped))).toEqual(Array.from(bytes));
  });

  test('random payloads agree with Buffer', () => {
    for (let i = 0; i < 200; i++) {
      const len = Math.floor(Math.random() * 64);
      const bytes = new Uint8Array(Array.from({ length: len }, () => Math.floor(Math.random() * 256)));
      expect(bytesToBase64(bytes)).toBe(oracleB64(bytes));
      expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
    }
  });
});

describe('utf8Encode', () => {
  const strings = [
    '',
    'plain ascii',
    'café',                  // 2-byte
    'こんにちは',              // 3-byte
    '👍🏽 emoji with modifier', // surrogate pairs
    'mixed: a£€𝄞z',
  ];

  test.each(strings)('matches Buffer for %p', (text) => {
    expect(Array.from(utf8Encode(text))).toEqual(Array.from(Buffer.from(text, 'utf8')));
  });

  test('a lone surrogate does not throw or desync', () => {
    // Not valid UTF-8 input, but it must not corrupt everything after it.
    const encoded = utf8Encode('a\uD800b');
    expect(encoded.length).toBeGreaterThan(0);
    expect(encoded[0]).toBe(0x61);
  });
});
