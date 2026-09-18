import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { getRandomBytes } from 'expo-crypto';
import { secureKeyValueStorage } from '@/lib/storage/secure-key-value';
import {
  bytesToBase64Url as encodeBase64Url,
  base64UrlToBytes as decodeBase64Url,
  utf8Encode,
} from '@/lib/encoding';

export type StoredDeviceIdentity = {
  version: 1;
  deviceId: string;
  publicKeyB64Url: string;
  privateKeyB64Url: string;
  createdAtMs: number;
};

const DEVICE_IDENTITY_KEY = 'versutus:device-identity';

// Hermes has no crypto.subtle and no crypto.getRandomValues. Noble v3 defaults
// both to WebCrypto, so a phone that never configured them could not create an
// identity, and every notifications.* / voice.session.start call went out
// without a deviceId.
ed.hashes.sha512 = (message) => sha512(message);
ed.hashes.sha512Async = async (message) => sha512(message);

export { DeviceIdentityError, DEVICE_IDENTITY_FAILURE } from '@/lib/gateway/errors';

// Re-exported from the engine-independent implementations: `btoa`/`atob` are
// not installed by React Native or Expo, and this is the pairing/signing path.
// See src/lib/encoding.ts.
const bytesToBase64Url = encodeBase64Url;
const base64UrlToBytes = decodeBase64Url;

function deriveDeviceId(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey));
}

function newSecretKey(): Uint8Array {
  // expo-crypto is the SDK-57 CSPRNG. Feeding the bytes as a seed means noble
  // never calls globalThis.crypto.getRandomValues, which Hermes does not have.
  return ed.utils.randomSecretKey(getRandomBytes(32));
}

async function createIdentity(): Promise<StoredDeviceIdentity> {
  const privateKey = newSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return {
    version: 1,
    deviceId: deriveDeviceId(publicKey),
    publicKeyB64Url: bytesToBase64Url(publicKey),
    privateKeyB64Url: bytesToBase64Url(privateKey),
    createdAtMs: Date.now(),
  };
}

export async function loadOrCreateDeviceIdentity(): Promise<StoredDeviceIdentity> {
  const raw = await secureKeyValueStorage.getItem(DEVICE_IDENTITY_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as StoredDeviceIdentity;
      if (
        parsed.version === 1 &&
        typeof parsed.deviceId === 'string' &&
        typeof parsed.publicKeyB64Url === 'string' &&
        typeof parsed.privateKeyB64Url === 'string'
      ) {
        const publicKey = base64UrlToBytes(parsed.publicKeyB64Url);
        const privateKey = base64UrlToBytes(parsed.privateKeyB64Url);
        const derivedId = deriveDeviceId(publicKey);
        const publicFromPrivate = await ed.getPublicKeyAsync(privateKey);
        const matches =
          publicKey.length === 32 &&
          privateKey.length === 32 &&
          bytesToBase64Url(publicFromPrivate) === bytesToBase64Url(publicKey);
        if (matches) {
          if (derivedId !== parsed.deviceId) {
            const repaired = { ...parsed, deviceId: derivedId };
            await secureKeyValueStorage.setItem(DEVICE_IDENTITY_KEY, JSON.stringify(repaired));
            return repaired;
          }
          return parsed;
        }
      }
    } catch {
      // fall through and regenerate
    }
  }

  const identity = await createIdentity();
  await secureKeyValueStorage.setItem(DEVICE_IDENTITY_KEY, JSON.stringify(identity));
  return identity;
}

export async function signDevicePayload(
  identity: StoredDeviceIdentity,
  payload: string,
): Promise<string> {
  const privateKey = base64UrlToBytes(identity.privateKeyB64Url);
  const signature = await ed.signAsync(utf8Encode(payload), privateKey);
  return bytesToBase64Url(signature);
}
