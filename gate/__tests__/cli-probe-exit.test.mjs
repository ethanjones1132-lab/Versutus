import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeVersion, runCli } from '../core/cli-environments/adapters/shared.mjs';
import { hermesAdapter } from '../core/cli-environments/adapters/hermes.mjs';
import { claudeCodeAdapter } from '../core/cli-environments/adapters/claude-code.mjs';
import { codexAdapter } from '../core/cli-environments/adapters/codex.mjs';

// Issue #1 item 6: `hermes --acp --probe` exits 2 ("unrecognized arguments")
// on Hermes 0.19, yet the environment reported `ready` because runCli's exit
// code was never looked at.

async function scriptedCli(body) {
  const dir = await mkdtemp(join(tmpdir(), 'gate-probe-'));
  const script = join(dir, 'cli.mjs');
  await writeFile(script, `#!/usr/bin/env node\nconst arg = process.argv.slice(2).join(' ');\n${body}\n`, 'utf8');
  await chmod(script, 0o755);
  return script;
}

const HERMES_019 = `
if (arg === '--version') { console.log('Hermes Agent v0.19.0 (2026.7.20)'); process.exit(0); }
if (arg === 'acp --version') { console.log('0.19.0'); process.exit(0); }
process.stderr.write('usage: hermes [-h] [--version]\\nhermes: error: unrecognized arguments: ' + arg + '\\n');
process.exit(2);
`;

test('a handshake that exits nonzero is a degraded probe that names stderr', async () => {
  const cli = await scriptedCli(HERMES_019);
  const probe = await probeVersion(cli, { min: '0.18.0', maxExclusiveMajor: 1, protocol: 'acp', handshakeArgs: ['--acp', '--probe'] });
  assert.equal(probe.state, 'degraded');
  assert.equal(probe.cliVersion, '0.19.0');
  assert.match(probe.message, /--acp --probe exited with code 2/);
  assert.match(probe.message, /unrecognized arguments: --acp --probe|usage: hermes/);
});

test('the hermes adapter probes ACP with a command 0.19 actually has', async () => {
  const cli = await scriptedCli(HERMES_019);
  const probe = await hermesAdapter.probe(cli);
  assert.equal(probe.state, 'ready', probe.message);
  assert.equal(probe.protocol, 'acp');
});

test('a --version that exits nonzero is not a runnable CLI, even if it printed a version', async () => {
  const cli = await scriptedCli(`console.log('1.2.3'); process.stderr.write('fatal: config unreadable\\n'); process.exit(1);`);
  const probe = await probeVersion(cli, { min: '1.0.0', maxExclusiveMajor: 2, protocol: 'x', handshakeArgs: ['x'] });
  assert.equal(probe.state, 'not_installed');
  assert.match(probe.message, /--version exited with code 1: fatal: config unreadable/);
});

test('a handshake help screen must list the protocol it is there to prove', async () => {
  const cli = await scriptedCli(`
if (arg === '--version') { console.log('2.1.140 (Claude Code)'); process.exit(0); }
if (arg === '--help') { console.log('Usage: claude [options]\\n  --output-format <format>  "text" or "json"'); process.exit(0); }
process.exit(1);`);
  const probe = await claudeCodeAdapter.probe(cli);
  assert.equal(probe.state, 'degraded');
  assert.match(probe.message, /does not offer stream-json/);
});

test('claude and codex handshakes pass on help screens that list their streaming formats', async () => {
  const claude = await scriptedCli(`
if (arg === '--version') { console.log('2.1.140 (Claude Code)'); process.exit(0); }
if (arg === '--help') { console.log('--output-format <format>  "text", "json", or "stream-json"'); process.exit(0); }
process.stderr.write("error: unknown option '" + arg + "'\\n"); process.exit(1);`);
  assert.equal((await claudeCodeAdapter.probe(claude)).state, 'ready');
  const codex = await scriptedCli(`
if (arg === '--version') { console.log('codex-cli 0.147.0'); process.exit(0); }
if (arg === 'exec --help') { console.log('      --json   Print events to stdout as JSONL'); process.exit(0); }
process.stderr.write("error: unexpected argument '" + arg + "' found\\n"); process.exit(2);`);
  assert.equal((await codexAdapter.probe(codex)).state, 'ready');
});

test('runCli still reports the exit code to callers that judge it themselves, with stdin closed', async () => {
  const cli = await scriptedCli(`
let n = 0;
process.stdin.on('data', (c) => { n += c.length; });
process.stdin.on('end', () => { process.stderr.write('eof ' + n + '\\n'); process.exit(3); });
process.stdin.resume();`);
  const result = await runCli(cli, [], { timeoutMs: 4000 });
  assert.equal(result.code, 3);
  assert.equal(result.stderr, 'eof 0');
});
