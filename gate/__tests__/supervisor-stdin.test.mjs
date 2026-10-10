import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliEnvironmentStore } from '../core/cli-environments/store.mjs';
import { CliAdapterRegistry } from '../core/cli-environments/adapter-registry.mjs';
import { CliEnvironmentService } from '../core/cli-environments/supervisor.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';

// `opencode run` reads stdin to EOF before it starts. execute() used to leave
// the child's stdin an open pipe nobody wrote to or closed, so such a task
// hung forever (issue #1: ~4.6 s with stdin closed, nothing after 20 s open).

async function eofWaitingCli(dir) {
  const script = join(dir, 'eof-cli.mjs');
  await writeFile(script, `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('0.142.1\\n'); process.exit(0); }
if (argv[argv.length - 1] === '--help') { process.stdout.write('--json  Print events to stdout as JSONL\\n'); process.exit(0); }
// The task itself: nothing happens until stdin reaches EOF.
let bytes = 0;
process.stdin.on('data', (chunk) => { bytes += chunk.length; });
process.stdin.on('end', () => { process.stdout.write('stdin closed after ' + bytes + ' bytes\\n'); process.exit(0); });
process.stdin.resume();
`, 'utf8');
  await chmod(script, 0o755);
  return script;
}

test('a task that waits for stdin EOF finishes, because the child gets no open stdin', async () => {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-stdin-'));
  const children = [];
  const spawnOptions = [];
  try {
    const store = new CliEnvironmentStore(gateHome);
    await store.put(validEnvironment({
      id: 'codex-local',
      adapterId: 'codex',
      executable: { path: await eofWaitingCli(gateHome) },
      workspacePolicy: { roots: [gateHome], defaultRoot: gateHome, defaultSandbox: 'read_only', allowAdditionalRoots: false },
    }));
    const service = new CliEnvironmentService({
      store,
      registry: new CliAdapterRegistry(),
      jobFactory: () => ({ add() {}, async terminate() {} }),
      spawnImpl: (command, args, options) => {
        spawnOptions.push(options);
        const child = spawn(command, args, options);
        children.push(child);
        return child;
      },
    });

    const handle = await service.startRun({
      environmentId: 'codex-local',
      operation: 'prompt',
      providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
      workspaceId: 'default',
      sandbox: 'read_only',
      input: { prompt: 'wait for eof' },
    });
    const collect = (async () => {
      const events = [];
      for await (const event of service.events(handle.runId)) {
        events.push(event);
        if (event.type === 'approval.required') await service.approve(handle.runId, event.payload.approvalId, 'approve');
      }
      return events;
    })();
    let timer;
    const events = await Promise.race([
      collect,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('the task never finished: its stdin was left open')), 8000);
      }),
    ]);
    clearTimeout(timer);

    assert.equal(spawnOptions.length, 1);
    assert.deepEqual(spawnOptions[0].stdio, ['ignore', 'pipe', 'pipe']);
    const terminal = events.at(-1);
    assert.equal(terminal.type, 'run.completed', JSON.stringify(terminal));
    const output = events.filter((event) => event.type === 'run.output').map((event) => event.payload.text).join('');
    assert.match(output, /stdin closed after 0 bytes/);
  } finally {
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
    await rm(gateHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
