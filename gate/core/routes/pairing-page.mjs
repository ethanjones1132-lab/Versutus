import { randomBytes, timingSafeEqual } from 'node:crypto';

const PAGE_TOKEN = randomBytes(32).toString('hex');
const MAX_FORM_BYTES = 4096;
const PAIRING_WINDOW_MS = 5 * 60 * 1000;

function isLoopback(address) {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

/**
 * The Host the browser asked for must itself be loopback. A loopback socket is
 * not enough: a web page whose domain is rebound to 127.0.0.1 (DNS rebinding)
 * reaches this page from the PC's own browser with its own Host, reads the
 * CSRF token same-origin, and could approve a phone a LAN neighbour filed.
 */
function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  const name = host.trim().toLowerCase().replace(/:\d+$/, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
}

/** A proxy in front of the Gate (Tailscale Serve, a reverse proxy) says so in one of these. */
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host'];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function ago(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function htmlPage(token, pending, windowOpen) {
  const forms = pending.length
    ? pending.map((entry) => {
      const title = [entry.name, entry.model].filter(Boolean).join(' · ')
        || entry.clientId
        || 'Phone';
      return `<li><div class="device"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(String(entry.deviceId).slice(0, 8))} · ${escapeHtml(ago(entry.requestedAtMs))}</span></div><div class="actions"><form method="post" action="/pair/approve"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="requestId" value="${escapeHtml(entry.requestId)}"><button class="approve" type="submit">Approve</button></form><form method="post" action="/pair/deny"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="requestId" value="${escapeHtml(entry.requestId)}"><button class="deny" type="submit">Deny</button></form></div></li>`;
    }).join('')
    : '<li class="empty">No phones are waiting.</li>';
  const windowControl = windowOpen
    ? '<p class="window open">Pairing window is open. The next phone will be granted automatically.</p>'
    : `<p class="window">Pairing window is closed.</p><form method="post" action="/pair/open"><input type="hidden" name="csrf" value="${token}"><button type="submit">Open for 5 minutes</button></form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="3"><title>Pair a phone · Versutus Gate</title><style>
    :root{color-scheme:light dark;font:16px system-ui,sans-serif;background:#111827;color:#f9fafb}body{max-width:680px;margin:8vh auto;padding:0 20px}h1{font-size:1.7rem;margin-bottom:.35rem}.sub,.device span{color:#aab4c5}ul{list-style:none;padding:0;margin:1.5rem 0}li{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:1px solid #374151}.device{display:grid;gap:5px;min-width:0}.device strong{overflow-wrap:anywhere}.actions{display:flex;gap:8px}button{border:0;border-radius:7px;padding:10px 15px;background:#374151;color:white;font:inherit;font-weight:650;cursor:pointer}.approve{background:#16834a}.deny{background:#8b3030}.window{margin:1.5rem 0 .6rem}.open{color:#68d391}.empty{color:#aab4c5;border:0}@media(max-width:520px){li{align-items:flex-start;flex-direction:column}.actions{width:100%}.actions form{flex:1}.actions button{width:100%}}
  </style></head><body><h1>Pair a phone</h1><p class="sub">Approve only a phone you recognize. This page is available from this PC only.</p><ul>${forms}</ul>${windowControl}</body></html>`;
}

function writeHtml(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > MAX_FORM_BYTES) {
        reject(new Error('Form too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function validToken(value) {
  const expected = Buffer.from(PAGE_TOKEN, 'hex');
  const supplied = /^[a-f0-9]{64}$/i.test(value ?? '')
    ? Buffer.from(value, 'hex')
    : Buffer.alloc(expected.length);
  const matches = timingSafeEqual(expected, supplied);
  return matches && /^[a-f0-9]{64}$/i.test(value ?? '');
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return false;
  if (origin !== undefined) {
    try {
      const parsed = new URL(origin);
      return parsed.origin === `http://${req.headers.host}`;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Handle the loopback-only operator page before general middleware can read a
 * request body. The token is process-local and never shared with a device.
 */
export async function handlePairingPage({ req, res, pathname, method, pairing, deviceTokens, port }) {
  if (pathname !== '/pair' && !pathname.startsWith('/pair/')) return false;

  if (!isLoopback(req.socket?.remoteAddress)
      || !isLoopbackHost(req.headers.host)
      || PROXY_HEADERS.some((name) => Object.hasOwn(req.headers, name))
      || Object.keys(req.headers).some((name) => name.startsWith('tailscale-'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  if (method === 'GET' && pathname === '/pair') {
    const [pending, windowOpen] = await Promise.all([pairing.listPending(), pairing.isWindowOpen()]);
    writeHtml(res, 200, htmlPage(PAGE_TOKEN, pending, windowOpen));
    return true;
  }

  if (method !== 'POST' || !['/pair/approve', '/pair/deny', '/pair/open'].includes(pathname)) {
    writeHtml(res, 404, 'Not found');
    return true;
  }

  if (!sameOrigin(req)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  let form;
  try {
    form = await readForm(req);
  } catch {
    res.writeHead(400);
    res.end('Invalid form');
    return true;
  }
  if (!validToken(form.get('csrf'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  if (pathname === '/pair/open') {
    await pairing.openWindow(PAIRING_WINDOW_MS);
  } else {
    const entry = await pairing.takePending(form.get('requestId') ?? '');
    if (entry && pathname === '/pair/approve') {
      // Deliberately discard the secret: only the signed phone status route
      // can deliver the issued token.
      await deviceTokens.issue(entry.deviceId, { role: entry.role, scopes: entry.scopes });
    }
  }
  res.writeHead(303, { Location: '/pair' });
  res.end();
  return true;
}
