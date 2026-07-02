import WebSocket from 'ws';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function buildPayload(params) {
  const platform = (params.platform ?? '').trim().toLowerCase();
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token ?? '',
    params.nonce,
    platform,
    '',
  ].join('|');
}

const privateKey = ed.utils.randomSecretKey();
const publicKey = await ed.getPublicKeyAsync(privateKey);
const deviceId = bytesToHex(sha256(publicKey));
const token = 'ce297599f3dbed257b3ffc5d8ce249201dd14bc5d51d13fc';

const socket = new WebSocket('ws://127.0.0.1:18789');
let connected = false;

socket.on('message', async (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.event === 'connect.challenge') {
    const signedAtMs = Date.now();
    const payload = buildPayload({
      deviceId,
      clientId: 'openclaw-android',
      clientMode: 'ui',
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      signedAtMs,
      token,
      nonce: msg.payload.nonce,
      platform: 'android',
    });
    const signature = bytesToBase64Url(await ed.signAsync(new TextEncoder().encode(payload), privateKey));
    socket.send(
      JSON.stringify({
        type: 'req',
        id: 'connect',
        method: 'connect',
        params: {
          minProtocol: 4,
          maxProtocol: 4,
          client: { id: 'openclaw-android', version: '1.0.0', platform: 'android', mode: 'ui' },
          role: 'operator',
          scopes: ['operator.read', 'operator.write'],
          caps: [],
          auth: { token },
          locale: 'en-US',
          userAgent: 'versutus/1.0.0',
          device: {
            id: deviceId,
            publicKey: bytesToBase64Url(publicKey),
            signature,
            signedAt: signedAtMs,
            nonce: msg.payload.nonce,
          },
        },
      }),
    );
    return;
  }
  if (msg.id === 'connect') {
    console.log('connect', msg.ok, msg.error?.message ?? 'ok');
    if (!msg.ok) {
      console.log('deviceId for approval:', deviceId);
      process.exit(1);
    }
    connected = true;
    socket.send(
      JSON.stringify({
        type: 'req',
        id: 'hist',
        method: 'chat.history',
        params: { sessionKey: 'agent:main:main', agentId: 'main', limit: 2 },
      }),
    );
    return;
  }
  if (msg.id === 'hist') {
    console.log('history count', msg.payload?.messages?.length ?? 0);
    socket.close();
  }
});

socket.on('close', () => process.exit(connected ? 0 : 1));
setTimeout(() => process.exit(1), 12000);