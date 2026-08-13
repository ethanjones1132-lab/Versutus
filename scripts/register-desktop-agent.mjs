import { createHash, createPublicKey, randomBytes, sign as cryptoSign, createPrivateKey } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const BASE = process.env.GATE_URL ?? 'http://127.0.0.1:8760';
const GRANT = '/.well-known/gateway/access';
const CLIENT_ID = 'grok-desktop';
const ROLE = 'operator';
const SCOPES = ['chat:send', 'chat:read', 'runs:start', 'runs:read', 'terminal:use', 'sessions:manage'];

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

const privateRaw = randomBytes(32);
const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, privateRaw]);
const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
const publicRaw = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
const deviceId = createHash('sha256').update(publicRaw).digest('hex');
const signedAtMs = Date.now();
const payload = ['v4', deviceId, CLIENT_ID, ROLE, SCOPES.join(','), String(signedAtMs)].join('|');
const signature = cryptoSign(null, Buffer.from(payload, 'utf8'), privateKey);

const body = {
  manifest: 'versutus-gateway/v1',
  device: {
    id: deviceId,
    publicKey: b64url(publicRaw),
    clientId: CLIENT_ID,
    clientMode: 'cli',
  },
  role: ROLE,
  scopes: SCOPES,
  signedAtMs,
  signature: b64url(signature),
  client: { name: 'Grok Desktop', version: '1.0.0', platform: 'desktop' },
};

const response = await fetch(`${BASE}${GRANT}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const result = await response.json();
const out = {
  httpStatus: response.status,
  deviceId,
  clientId: CLIENT_ID,
  status: result.status,
  requestId: result.requestId ?? null,
  role: result.role ?? ROLE,
  scopes: result.scopes ?? SCOPES,
};
if (result.token) out.token = result.token;
console.log(JSON.stringify(out, null, 2));

if (result.status === 'granted' && result.token) {
  await writeFile(
    new URL('../gate/.grok-desktop-device.json', import.meta.url),
    JSON.stringify({ deviceId, clientId: CLIENT_ID, token: result.token, role: result.role, scopes: result.scopes }, null, 2) + '\n',
    'utf8',
  );
}
