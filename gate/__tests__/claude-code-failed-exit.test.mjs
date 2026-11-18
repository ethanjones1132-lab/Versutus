import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClaudeCodeBackend, transcriptDirFor } from '../core/cli-environments/backends/claude-code.mjs';
import { runBackendTurn } from '../core/voice/turn-runner.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const SESSION_ID = '896a9c65-7554-453a-8e20-ccf419617968';

async function setup({ exitCode, lines }) {
  const home = await mkdtemp(join(tmpdir(), 'claude-failed-exit-'));
  roots.push(home);
  const cwd = 'C:\\Projects\\Versutus';
  await mkdir(transcriptDirFor(home, cwd), { recursive: true });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setTimeout(() => {
    for (const line of lines) child.stdout.emit('data', `${JSON.stringify(line)}\n`);
    child.emit('close', exitCode);
  }, 0);
  const backend = createClaudeCodeBackend({
    claudeHome: home,
    cwd,
    executablePath: 'claude.exe',
    spawnImpl: () => child,
  });
  return { backend };
}

const partialLines = [
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'unfinished reply' } } },
];

for (const exitCode of [null, 17]) {
  test(`partial output followed by ${exitCode === null ? 'signal death' : 'a non-zero exit'} fails with its partial`, async () => {
    const { backend } = await setup({ exitCode, lines: partialLines });
    const seen = [];
    await assert.rejects(
      backend.sendMessage(SESSION_ID, { text: 'hi' }, (event) => seen.push(event)),
      (error) => {
        assert.equal(error.partialText, 'unfinished reply');
        assert.equal(error.payload.partialText, 'unfinished reply');
        assert.match(error.message, exitCode === null ? /code null/ : /code 17/);
        return true;
      },
    );
    assert.equal(seen.filter((event) => event.type === 'run.completed').length, 0);
    assert.deepEqual(seen.find((event) => event.type === 'run.failed')?.payload.partialText, 'unfinished reply');
  });
}

test('a zero exit with an explicit successful result completes normally', async () => {
  const { backend } = await setup({
    exitCode: 0,
    lines: [...partialLines, { type: 'result', subtype: 'success', result: 'unfinished reply', num_turns: 1 }],
  });
  const result = await backend.sendMessage(SESSION_ID, { text: 'hi' });
  assert.equal(result.text, 'unfinished reply');
  assert.equal(result.message.content[0].text, 'unfinished reply');
});

test('the runner rejects and records failure instead of settling partial text as a reply', async () => {
  const { backend } = await setup({ exitCode: 9, lines: partialLines });
  const deltas = [];
  const stages = [];
  await assert.rejects(
    runBackendTurn(backend, SESSION_ID, { text: 'hi' }, {
      onDelta: (text) => deltas.push(text),
      onStage: ({ stage }) => stages.push(stage),
    }),
    (error) => {
      assert.equal(error.partialText, 'unfinished reply');
      return true;
    },
  );
  assert.deepEqual(deltas, ['unfinished reply'], 'the partial remains available as partial output');
  assert.ok(stages.includes('turn.failed'));
  assert.ok(!stages.includes('turn.settled'), 'a failed process cannot settle as a completed turn');
});
