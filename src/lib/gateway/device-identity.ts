import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export type StoredDeviceIdentity = {
  version: 1;
  deviceId: string;
  publicKeyB64Url: string;
  privateKeyB64Url: string;
  createdAtMs: number;
};
import { keyValueStorage } from '@/lib/storage/key-value';

const DEVICE_IDENTITY_KEY = 'versutus:device-identity';

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

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
  const raw = await keyValueStorage.getItem(DEVICE_IDENTITY_KEY);
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
            await keyValueStorage.setItem(DEVICE_IDENTITY_KEY, JSON.stringify(repaired));
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
  await keyValueStorage.setItem(DEVICE_IDENTITY_KEY, JSON.stringify(identity));
  return identity;
}

export async function signDevicePayload(
  identity: StoredDeviceIdentity,
  payload: string,
): Promise<string> {
  const privateKey = base64UrlToBytes(identity.privateKeyB64Url);
  const signature = await ed.signAsync(new TextEncoder().encode(payload), privateKey);
  return bytesToBase64Url(signature);
}
