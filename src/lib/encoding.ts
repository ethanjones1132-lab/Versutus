/**
 * Base64 and UTF-8 without the globals React Native does not have.
 *
 * `btoa`, `atob` and `TextEncoder` are installed by neither React Native 0.86
 * (nothing in `Libraries/` defines them) nor Expo's WinterCG runtime, whose
 * installed set is explicit at `expo/src/winter/runtime.native.ts` —
 * `TextDecoder`, `TextDecoderStream`, `TextEncoderStream`, `URL`,
 * `URLSearchParams`, `DOMException`, `structuredClone`. Whether they exist
 * comes down to what the bundled Hermes happens to provide, which is invisible
 * to every test in this repo because they all run in Node, where they do.
 *
 * Device pairing and request signing called them unguarded. Rather than detect
 * and branch — which still leaves a path nothing can test — these implement the
 * transforms directly, so behaviour is the same on every engine and is covered
 * by ordinary Node tests.
 *
 * `TextDecoder` is deliberately still used at call sites: Expo does install it.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const LOOKUP = /*#__PURE__*/ (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

/**
 * Decode standard or URL-safe base64. Padding is optional, and characters
 * outside the alphabet (whitespace, newlines from a wrapped payload) are
 * ignored rather than silently corrupting the output.
 */
export function base64ToBytes(input: string): Uint8Array {
  let bits = 0;
  let bitCount = 0;
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    // URL-safe aliases, normalised inline so callers need not pre-translate.
    const symbol = code === 45 ? 62 : code === 95 ? 63 : code < 128 ? LOOKUP[code] : -1;
    if (symbol < 0) continue; // '=' and any padding/whitespace
    bits = (bits << 6) | symbol;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out.push((bits >> bitCount) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(input: string): Uint8Array {
  return base64ToBytes(input);
}

/** UTF-8 encode, standing in for the absent `TextEncoder`. */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.codePointAt(i) as number;
    // A surrogate pair is one code point across two UTF-16 units.
    if (cp > 0xffff) i++;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}
