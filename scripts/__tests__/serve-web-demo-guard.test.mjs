// Pin for the serve-web-demo traversal guard (../serve-web-demo.mjs).
//
// The demo server is the pilot buyer's first ten minutes: `npm run serve:web`
// must serve ONLY the export directory. The guard used to be a bare
// `resolved.startsWith(ROOT)`, so any SIBLING directory whose name merely
// extends the served directory's name (`dist` vs `dist-evil`) passed the
// prefix check and its files were reachable over HTTP. The guard now requires
// `ROOT + path.sep`. These tests spawn the real script and prove both sides:
// sibling escapes are 404 while ordinary in-root serving still works.
//
// Lives under scripts/__tests__ (not gate/__tests__) because it pins a repo
// script; it runs through the same `npm run test:gate` node --test leg.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http, { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDemoServer, parsePort } from '../serve-web-demo.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const DEMO_SCRIPT = join(SCRIPTS_DIR, '..', 'serve-web-demo.mjs');

// In-process harness for the read-failure pin: the handler is the real one,
// only the disk read is stubbed, so the test is hermetic and deterministic
// (no permission tricks, no live filesystem races).
async function withStubbedRead(root, readFileFn, run) {
  const server = createDemoServer({ root, readFileFn });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk.toString();
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

async function waitForServer(port) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await get(port, '/');
      if (res.status !== undefined) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error('demo server never answered');
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function withDemoServer(run) {
  // Fixture mirrors the reported shape: served dir `demo-dist`, sibling
  // `demo-dist-evil` — the sibling's full path STARTS WITH the served dir's
  // path, which is exactly what the bare-prefix guard let through.
  const base = await mkdtemp(join(tmpdir(), 'vs-demo-'));
  const servedDir = join(base, 'demo-dist');
  const siblingDir = join(base, 'demo-dist-evil');
  await mkdir(servedDir);
  await mkdir(siblingDir);
  await writeFile(join(servedDir, 'index.html'), '<h1>demo-home</h1>');
  await writeFile(join(siblingDir, 'secret.txt'), 'sibling-secret');

  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      DEMO_SCRIPT,
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--dir',
      servedDir,
    ],
    { cwd: join(SCRIPTS_DIR, '..', '..'), stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(port);
    await run(port, siblingDir);
  } catch (error) {
    if (stderr) console.error('demo server stderr:', stderr);
    throw error;
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
  }
}

test('serves the export directory itself', async () => {
  await withDemoServer(async (port) => {
    const home = await get(port, '/');
    assert.equal(home.status, 200);
    assert.ok(home.body.includes('demo-home'));
    const direct = await get(port, '/index.html');
    assert.equal(direct.status, 200);
  });
});

test('404s dot-dot escapes into a sibling directory', async () => {
  await withDemoServer(async (port, siblingDir) => {
    const escape = `/../${siblingDir.split(/[\\/]/).pop()}/secret.txt`;
    const raw = await get(port, escape);
    assert.equal(raw.status, 404);
    assert.ok(!raw.body.includes('sibling-secret'));
  });
});

test('404s percent-encoded dot-dot escapes into a sibling directory', async () => {
  await withDemoServer(async (port, siblingDir) => {
    const escape = `/%2e%2e/${siblingDir.split(/[\\/]/).pop()}/secret.txt`;
    const encoded = await get(port, escape);
    assert.equal(encoded.status, 404);
    assert.ok(!encoded.body.includes('sibling-secret'));
  });
});

// --- read failures -------------------------------------------------------
//
// `createServer(async (req, res) => ...)` used to await `readFile` with no
// catch. An export:web rebuild that removes a file between `stat` and
// `readFile` rejected the handler promise, and Node exits on an unhandled
// rejection — the buyer's demo server vanished mid sign-off. These pins stub
// only the read so the failure is deterministic on every OS.

async function readFailureFixture() {
  const base = await mkdtemp(join(tmpdir(), 'vs-demo-read-'));
  await writeFile(join(base, 'index.html'), '<h1>demo-home</h1>');
  await writeFile(join(base, 'locked.txt'), 'locked-body');
  return base;
}

function fsError(code, message = `${code}: simulated failure`) {
  return Object.assign(new Error(message), { code });
}

test('unreadable file returns 403 instead of crashing the server', async () => {
  const root = await readFailureFixture();
  const stub = async (file) => {
    if (file.endsWith('locked.txt')) throw fsError('EACCES', `EACCES: permission denied, open ${file}`);
    return readFile(file);
  };

  await withStubbedRead(root, stub, async (port) => {
    const denied = await get(port, '/locked.txt');
    assert.equal(denied.status, 403);
    assert.ok(denied.body.includes('403'));
    // no absolute export path or OS error text in the buyer's response
    assert.ok(!denied.body.includes(root), 'response leaked the export directory');
    assert.ok(!denied.body.includes('permission denied'), 'response leaked the OS error');

    // the server is still alive: this is the regression that killed the demo
    const home = await get(port, '/');
    assert.equal(home.status, 200);
    assert.ok(home.body.includes('demo-home'));
  });
});

test('file removed between stat and read returns 404 and the server keeps serving', async () => {
  const root = await readFailureFixture();
  const stub = async (file) => {
    if (file.endsWith('locked.txt')) throw fsError('ENOENT');
    return readFile(file);
  };

  await withStubbedRead(root, stub, async (port) => {
    const gone = await get(port, '/locked.txt');
    assert.equal(gone.status, 404);
    assert.ok(gone.body.includes('404'));

    const home = await get(port, '/');
    assert.equal(home.status, 200);
    assert.ok(home.body.includes('demo-home'));
  });
});

test('unexpected read error returns a generic 500 and the server keeps serving', async () => {
  const root = await readFailureFixture();
  const stub = async (file) => {
    if (file.endsWith('locked.txt')) throw fsError('EIO', `EIO: i/o error, read ${file}`);
    return readFile(file);
  };

  await withStubbedRead(root, stub, async (port) => {
    const failed = await get(port, '/locked.txt');
    assert.equal(failed.status, 500);
    assert.ok(failed.body.includes('500'));
    assert.ok(!failed.body.includes(root), 'response leaked the export directory');
    assert.ok(!failed.body.includes('i/o error'), 'response leaked the OS error');

    const home = await get(port, '/');
    assert.equal(home.status, 200);
  });
});

test('HEAD on an unreadable file returns the error status with no body', async () => {
  const root = await readFailureFixture();
  const stub = async () => {
    throw fsError('EACCES');
  };

  await withStubbedRead(root, stub, async (port) => {
    const head = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/locked.txt', method: 'HEAD' },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk.toString();
          });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(head.status, 403);
    assert.equal(head.body, '');
  });
});

// --- port configuration --------------------------------------------------
//
// The script documents "Exit codes: server runs until Ctrl+C · 2 configuration
// error before binding." `--port` used to be `Number(raw)` handed straight to
// `server.listen`, so `--port abc` bound NaN and `--port 70000` was out of
// range: Node answered with an uncaught ERR_SOCKET_BAD_PORT stack trace on a
// port the buyer never chose, and only after the export directory had been
// checked. These pins cover the pure parser and the real CLI exit path.

test('parsePort defaults to 8090 when the flag is absent', () => {
  assert.deepEqual(parsePort(undefined), { port: 8090 });
  assert.deepEqual(parsePort(undefined, { given: false }), { port: 8090 });
});

test('parsePort accepts every usable port', () => {
  assert.deepEqual(parsePort('1'), { port: 1 });
  assert.deepEqual(parsePort('8090'), { port: 8090 });
  assert.deepEqual(parsePort('65535'), { port: 65535 });
  // whitespace around the value is a shell artifact, not a typo worth failing
  assert.deepEqual(parsePort(' 9000 '), { port: 9000 });
});

test('parsePort rejects non-numeric, empty and misspelled values', () => {
  for (const raw of ['abc', '', '   ', '80 90', '1e3', '0x1f90', '8090abc', 'NaN', '-1', '+8090', '8,090']) {
    const result = parsePort(raw);
    assert.ok(result.error, `expected ${JSON.stringify(raw)} to be rejected`);
    assert.equal(result.port, undefined);
    assert.match(result.error, /1 and 65535/);
  }
});

test('parsePort rejects out-of-range ports including 0 and non-integers', () => {
  for (const raw of ['0', '65536', '70000', '999999999999999999999', '3.5', '8090.0']) {
    const result = parsePort(raw);
    assert.ok(result.error, `expected ${JSON.stringify(raw)} to be rejected`);
    assert.match(result.error, /1 and 65535/);
  }
});

test('parsePort reports a dangling --port flag instead of silently using 8090', () => {
  const result = parsePort(undefined, { given: true });
  assert.ok(result.error);
  assert.match(result.error, /needs a value/);
});

// Spawn the real script so the exit code, the stream it writes to, and the
// absence of a socket stack trace are all pinned end to end.
function runDemoCli(extraArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DEMO_SCRIPT, ...extraArgs], {
      cwd: join(SCRIPTS_DIR, '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`demo script did not exit for ${JSON.stringify(extraArgs)}`));
    }, 15_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function invalidPortArguments() {
  // A real export directory, so a failure can only come from the port check.
  const base = await mkdtemp(join(tmpdir(), 'vs-demo-port-'));
  await writeFile(join(base, 'index.html'), '<h1>demo-home</h1>');
  return base;
}

test('invalid port exits 2 with a usable message and never binds', async () => {
  const dir = await invalidPortArguments();
  for (const portArg of ['abc', '70000', '0', '3.5', '-1', '']) {
    const result = await runDemoCli(['--port', portArg, '--host', '127.0.0.1', '--dir', dir]);
    assert.equal(result.code, 2, `--port ${JSON.stringify(portArg)} should exit 2`);
    assert.equal(result.signal, null);
    // nothing was advertised: the server never reached the listen callback
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /configuration error/);
    assert.match(result.stderr, /--port/);
    assert.match(result.stderr, /1 and 65535/);
    assert.match(result.stderr, /usage: npm run serve:web/);
    // no Node socket stack trace leaking in place of the documented exit
    assert.ok(!result.stderr.includes('ERR_SOCKET_BAD_PORT'), 'leaked a bind-time socket error');
    assert.ok(!result.stderr.includes('at Server.listen'), 'leaked a stack trace');
  }
});

test('dangling --port at the end of argv is a configuration error', async () => {
  const dir = await invalidPortArguments();
  const result = await runDemoCli(['--dir', dir, '--port']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /needs a value/);
});

test('port validation runs before the export directory check', async () => {
  // Both inputs are wrong. The port message must win so a buyer who mistyped
  // the port is not sent off to rebuild dist/ first.
  const missingDir = join(tmpdir(), 'vs-demo-does-not-exist-2f8c1d');
  const result = await runDemoCli(['--port', 'not-a-port', '--dir', missingDir]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--port/);
  assert.match(result.stderr, /1 and 65535/);
  assert.ok(!result.stderr.includes('export directory not found'), 'directory check won over the port check');
});
