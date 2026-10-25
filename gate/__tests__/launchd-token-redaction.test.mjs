import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLaunchAgent } from '../core/service/launchd-agent.mjs';
import {
  bootstrapTokenLine,
  TOKEN_REDACTED_LINE,
  TOKEN_REDACTION_ENV,
  tokenRedactionRequested,
} from '../core/service/rotating-log.mjs';

const gateRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(gateRoot);

test('launchd plist sets the bootstrap-token redaction flag', () => {
  const agent = buildLaunchAgent({ nodeExe: '/n/bin/node', codeRoot: '/code', home: '/Users/e' });

  assert.equal(agent.environment[TOKEN_REDACTION_ENV], '1');
  assert.match(agent.plist, new RegExp(`<key>${TOKEN_REDACTION_ENV}</key>\\s*<string>1</string>`));
});

test('the redaction helpers preserve interactive output and recognize disabled values', () => {
  assert.equal(TOKEN_REDACTED_LINE, 'Token: [redacted]');
  assert.equal(tokenRedactionRequested({ [TOKEN_REDACTION_ENV]: '1' }), true);
  assert.equal(bootstrapTokenLine('secret', { [TOKEN_REDACTION_ENV]: '1' }), TOKEN_REDACTED_LINE);
  assert.equal(bootstrapTokenLine('secret', {}), 'Token: secret');

  for (const value of ['', '0', 'false', 'no']) {
    assert.equal(tokenRedactionRequested({ [TOKEN_REDACTION_ENV]: value }), false, JSON.stringify(value));
  }
});

test('the real CLI start path redacts only when the flag is set', async () => {
  const flagged = await runIsolatedStart({ redact: true });
  assert.deepEqual(flagged.tokenLines, [TOKEN_REDACTED_LINE]);
  assert.equal(flagged.stdout.includes(flagged.token), false, 'redacted output must not contain the bootstrap token');

  const interactive = await runIsolatedStart({ redact: false });
  assert.deepEqual(interactive.tokenLines, [`Token: ${interactive.token}`]);
  assert.ok(interactive.stdout.includes(interactive.token), 'interactive output still exposes the token to the operator');
});

async function runIsolatedStart({ redact }) {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'gate-token-redaction-'));
  const sandboxGate = join(sandboxRoot, 'gate');
  const workspaceNodeModules = join(repositoryRoot, 'node_modules');
  let child;
  let stdout = '';
  let stderr = '';

  try {
    await cp(gateRoot, sandboxGate, {
      recursive: true,
      filter(source) {
        const path = relative(gateRoot, source);
        if (path === '') return true;
        return !path.split(sep).some((part) => part.startsWith('.') || part === 'node_modules');
      },
    });
    await symlink(workspaceNodeModules, join(sandboxRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

    const port = await availablePort();
    const env = {
      ...process.env,
      VERSUTUS_GATE_HOME: join(sandboxRoot, 'gate-home'),
      VERSUTUS_GATE_HOST: '127.0.0.1',
      VERSUTUS_GATE_PORT: String(port),
    };
    if (redact) env[TOKEN_REDACTION_ENV] = '1';
    else delete env[TOKEN_REDACTION_ENV];

    child = spawn(process.execPath, [join(sandboxGate, 'cli.mjs'), 'start'], {
      cwd: sandboxRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const closed = once(child, 'close');

    await waitForOutput(child, () => stdout.includes(`Listening on 127.0.0.1:${port}`), () => stdout, () => stderr);
    const token = JSON.parse(await readFile(join(sandboxGate, '.tokens.json'), 'utf8')).token;
    assert.equal(typeof token, 'string');

    child.kill();
    await closed;

    return {
      stdout,
      token,
      tokenLines: stdout.split(/\r?\n/).filter((line) => line.startsWith('Token:')),
    };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
    await rm(sandboxRoot, { recursive: true, force: true });
  }
}

async function waitForOutput(child, ready, getStdout, getStderr) {
  const deadline = Date.now() + 45_000;
  while (!ready()) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`gate start exited before listening (${child.exitCode ?? child.signalCode})\n${getStdout()}\n${getStderr()}`);
    }
    if (Date.now() >= deadline) throw new Error(`gate start timed out\n${getStdout()}\n${getStderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}
