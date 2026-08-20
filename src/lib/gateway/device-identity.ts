import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
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

// Re-exported from the engine-independent implementations: `btoa`/`atob` are
// not installed by React Native or Expo, and this is the pairing/signing path.
// See src/lib/encoding.ts.
const bytesToBase64Url = encodeBase64Url;
const base64UrlToBytes = decodeBase64Url;

function deriveDeviceId(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey));
}

async function createIdentity(): Promise<StoredDeviceIdentity> {
  const privateKey = ed.utils.randomSecretKey();
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
