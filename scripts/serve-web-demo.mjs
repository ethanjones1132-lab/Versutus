// Zero-install web demo server.
//
// Serves the statically exported web bundle (npm run export:web -> dist/) so a
// pilot buyer needs ONLY a browser on the same network as the Gate machine:
// no Metro console, no APK, no dev server. The buyer's browser origin must be
// allow-listed by the Gate (CORS is opt-in since 68ab755), so this script
// prints every candidate origin it can be reached on and the exact Gate flag
// to pair with it — copy one line into the Gate's start command and done.
//
// Usage:
//   npm run serve:web                        # dist/ on port 8090, all interfaces
//   npm run serve:web -- --port 9000         # pick another port
//   npm run serve:web -- --dir ../elsewhere  # serve a different export directory
//
// Options:
//   --port <n>    listen port   (default 8090)
//   --host <ip>   bind address  (default 0.0.0.0 — reachable from LAN/tailnet)
//   --dir <path>  export dir    (default <repo>/dist)
//
// Exit codes: server runs until Ctrl+C · 2 configuration error before binding.
//
// Dependency-free on purpose (node:http only): the Gate machine should not
// need any install beyond this repository to host the demo.

import { createServer } from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const optValue = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const PORT = Number(optValue('--port') ?? 8090);
const HOST = optValue('--host') ?? '0.0.0.0';
const ROOT = path.resolve(optValue('--dir') ?? path.join(REPO_ROOT, 'dist'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

const NOT_FOUND_HTML = `<!doctype html><meta charset="utf-8"><title>Versutus demo</title>
<body style="background:#08080A;color:#E6E6EB;font-family:sans-serif;padding:2rem">
<h1>404</h1><p>This demo serves the exported routes only.</p>
<p>Start again from <a style="color:#7CC4FF" href="/">the home page</a>.</p>
</body>`;

function candidateOrigins(port) {
  const urls = [];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      urls.push(`http://${iface.address}:${port}`);
    }
  }
  return urls;
}

async function resolveFile(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  const resolved = path.normalize(path.join(ROOT, pathname));
  // traversal guard: the separator suffix is required so a SIBLING directory
  // whose name merely extends ours (dist vs dist-evil) cannot pass the check
  if (!resolved.startsWith(ROOT + path.sep)) return null;

  const attempts = [resolved];
  if (pathname.endsWith('/')) attempts.push(path.join(resolved, 'index.html'));
  attempts.push(`${resolved}.html`);

  for (const attempt of attempts) {
    try {
      const info = await stat(attempt);
      if (info.isFile()) return attempt;
      if (info.isDirectory()) attempts.push(path.join(attempt, 'index.html'));
    } catch {
      // fall through to the next candidate
    }
  }
  return null;
}

const rootStat = await stat(ROOT).catch(() => null);
if (!rootStat?.isDirectory()) {
  console.error(`export directory not found: ${ROOT}`);
  console.error('run `npm run export:web` first');
  process.exit(2);
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const file = await resolveFile(req.url ?? '/');
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : NOT_FOUND_HTML);
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // sign-off day must never show yesterday's bundle through a shared cache
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
});

server.listen(PORT, HOST, () => {
  console.log(`serving ${ROOT}`);
  console.log('');
  console.log('open in the buyer browser (pick ONE origin and stay on it):');
  console.log(`  local machine : http://localhost:${PORT}`);
  for (const url of candidateOrigins(PORT)) console.log(`  network       : ${url}`);
  console.log('');
  console.log('the Gate must allow that exact origin (CORS is opt-in):');
  console.log(`  versutus-gate --allow-origin http://<address-from-above>:${PORT}`);
  console.log('');
  console.log('Ctrl+C stops the server.');
});
