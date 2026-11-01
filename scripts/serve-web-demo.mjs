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
//   --port <n>    listen port   (1-65535, default 8090)
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
const optValue = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const DEFAULT_PORT = 8090;
const PORT_ARG = optValue('--port');
const PORT_FLAG_GIVEN = argv.includes('--port');
const HOST = optValue('--host') ?? '0.0.0.0';
const ROOT = path.resolve(optValue('--dir') ?? path.join(REPO_ROOT, 'dist'));

// `Number('abc')` is NaN and `Number('70000')` is out of range; both used to be
// handed straight to `server.listen`, which threw ERR_SOCKET_BAD_PORT at bind
// time with a stack trace and no hint about the flag. The script documents
// exit code 2 for a configuration error, so validate before touching the disk
// or the socket. Port 0 is rejected too: the printed origin lines and the
// Gate's `--allow-origin` flag must name the real port a buyer will use, and an
// ephemeral port would make those instructions wrong.
export function parsePort(raw, { given = raw !== undefined } = {}) {
  if (!given) return { port: DEFAULT_PORT };
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(text)) {
    return { error: `--port expects an integer between 1 and 65535, got ${describeArg(raw)}` };
  }
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return { error: `--port expects an integer between 1 and 65535, got ${text}` };
  }
  return { port };
}

// Quote the offending token so an empty or whitespace-only value is visible in
// the terminal instead of producing a confusing "got " message.
function describeArg(raw) {
  if (raw === undefined) return 'nothing (the flag needs a value)';
  if (typeof raw !== 'string') return String(raw);
  return raw.trim() === '' ? 'an empty value' : JSON.stringify(raw);
}

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

// Bodies for read failures are deliberately generic: the buyer's browser must
// never learn an absolute export path or an OS error string.
function serverErrorHtml(status) {
  const message =
    status === 403
      ? 'The demo server is not allowed to read this file.'
      : 'The demo server could not read this file.';
  return `<!doctype html><meta charset="utf-8"><title>Versutus demo</title>
<body style="background:#08080A;color:#E6E6EB;font-family:sans-serif;padding:2rem">
<h1>${status}</h1><p>${message}</p>
<p>Start again from <a style="color:#7CC4FF" href="/">the home page</a>.</p>
</body>`;
}

// A file that disappears between `stat` and `readFile` (export:web rebuilding
// dist/ mid-demo) is a 404, an unreadable one a 403, anything else a 500.
function readErrorStatus(error) {
  switch (error?.code) {
    case 'ENOENT':
    case 'ENOTDIR':
    case 'EISDIR':
      return 404;
    case 'EACCES':
    case 'EPERM':
      return 403;
    default:
      return 500;
  }
}

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

async function resolveFile(root, urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  const resolved = path.normalize(path.join(root, pathname));
  // traversal guard: the separator suffix is required so a SIBLING directory
  // whose name merely extends ours (dist vs dist-evil) cannot pass the check
  if (!resolved.startsWith(root + path.sep)) return null;

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

function sendError(res, status, method) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(method === 'HEAD' ? undefined : status === 404 ? NOT_FOUND_HTML : serverErrorHtml(status));
}

// Exported so tests can drive the real handler with a stubbed read: a read
// failure must answer with an HTTP error, never reject the async request
// handler (an unhandled rejection kills the whole demo server).
export function createDemoServer({ root, readFileFn = readFile } = {}) {
  const serveRoot = path.resolve(root);
  return createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      const file = await resolveFile(serveRoot, req.url ?? '/');
      if (!file) {
        sendError(res, 404, req.method);
        return;
      }
      let body;
      try {
        body = await readFileFn(file);
      } catch (error) {
        const status = readErrorStatus(error);
        console.error(`demo: cannot read ${file}: ${error instanceof Error ? error.message : error}`);
        sendError(res, status, req.method);
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
        // sign-off day must never show yesterday's bundle through a shared cache
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      // Last line of defence: one broken request must not take the demo down.
      console.error(`demo: request failed: ${req.method} ${req.url}:`, error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      try {
        sendError(res, 500, req.method);
      } catch {
        res.destroy();
      }
    }
  });
}

async function main() {
  const parsedPort = parsePort(PORT_ARG, { given: PORT_FLAG_GIVEN });
  if (parsedPort.error) {
    console.error(`configuration error: ${parsedPort.error}`);
    console.error('usage: npm run serve:web -- --port <1-65535> [--host <ip>] [--dir <path>]');
    process.exit(2);
  }
  const port = parsedPort.port;

  const rootStat = await stat(ROOT).catch(() => null);
  if (!rootStat?.isDirectory()) {
    console.error(`export directory not found: ${ROOT}`);
    console.error('run `npm run export:web` first');
    process.exit(2);
  }

  const server = createDemoServer({ root: ROOT });

  server.listen(port, HOST, () => {
    console.log(`serving ${ROOT}`);
    console.log('');
    console.log('open in the buyer browser (pick ONE origin and stay on it):');
    console.log(`  local machine : http://localhost:${port}`);
    for (const url of candidateOrigins(port)) console.log(`  network       : ${url}`);
    console.log('');
    console.log('the Gate must allow that exact origin (CORS is opt-in):');
    console.log(`  versutus-gate --allow-origin http://<address-from-above>:${port}`);
    console.log('');
    console.log('Ctrl+C stops the server.');
  });
}

const launchedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (launchedDirectly) await main();
