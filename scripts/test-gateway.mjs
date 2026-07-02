import WebSocket from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const openclawDist = path.join(process.env.APPDATA, 'npm', 'node_modules', 'openclaw', 'dist');

const toFileUrl = (p) => new URL(`file:///${p.replace(/\\/g, '/')}`).href;
const deviceIdentity = await import(toFileUrl(path.join(openclawDist, 'device-identity-CEPJolq9.js')));
const { loadOrCreateDeviceIdentity: loadIdentity, signDevicePayload, publicKeyRawBase64UrlFromPem } = deviceIdentity;
const loadOrCreateDeviceIdentity = loadIdentity ?? deviceIdentity.r;
const { buildDeviceAuthPayloadV3 } = await import(toFileUrl(path.join(openclawDist, 'client-C6EKqjh8.js')));

const identity = loadOrCreateDeviceIdentity();
const token = 'ce297599f3dbed257b3ffc5d8ce249201dd14bc5d51d13fc';
let challengeNonce = null;
let connected = false;

const socket = new WebSocket('ws://127.0.0.1:18789');

function sendConnect() {
  const signedAtMs = Date.now();
  const role = 'operator';
  const scopes = ['operator.read', 'operator.write'];
  const clientId = 'openclaw-android';
  const clientMode = 'ui';
  const payload = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId,
    clientId,
    clientMode,
    role,
    scopes,
    signedAtMs,
    token,
    nonce: challengeNonce,
    platform: 'android',
    deviceFamily: '',
  });
  const signature = signDevicePayload(identity.privateKeyPem, payload);
  const req = {
    type: 'req',
    id: 'connect-1',
    method: 'connect',
    params: {
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: clientId, version: '1.0.0', platform: 'android', mode: clientMode },
      role,
      scopes,
      caps: [],
      auth: { token },
      locale: 'en-US',
      userAgent: 'versutus/1.0.0',
      device: {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        signature,
        signedAt: signedAtMs,
        nonce: challengeNonce,
      },
    },
  };
  socket.send(JSON.stringify(req));
}

socket.on('open', () => console.log('socket open'));
socket.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.event === 'connect.challenge') {
    challengeNonce = msg.payload.nonce;
    sendConnect();
    return;
  }
  if (msg.id === 'connect-1') {
    console.log('connect result', JSON.stringify(msg, null, 2).slice(0, 800));
    if (msg.ok) {
      connected = true;
      socket.send(
        JSON.stringify({
          type: 'req',
          id: 'health-1',
          method: 'health',
          params: {},
        }),
      );
    }
    return;
  }
  if (msg.id === 'health-1') {
    console.log('health ok', msg.ok);
    socket.send(
      JSON.stringify({
        type: 'req',
        id: 'hist-1',
        method: 'chat.history',
        params: { sessionKey: 'agent:main:main', limit: 2 },
      }),
    );
    return;
  }
  if (msg.id === 'hist-1') {
    console.log('history messages', msg.payload?.messages?.length ?? 0);
    socket.close();
  }
});
socket.on('close', (code, reason) => {
  console.log('closed', code, reason.toString());
  process.exit(connected ? 0 : 1);
});
setTimeout(() => {
  console.log('timeout');
  process.exit(1);
}, 15000);