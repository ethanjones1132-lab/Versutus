import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A fake Hermes CLI that can actually answer a prompt, so the wedge loop
 * (start run → streamed reply → completion) is provable end to end without a
 * real Hermes install. Speaks the three invocations the hermes adapter makes:
 *
 *   --version        → the given semver (probeVersion)
 *   --acp ...        → exits 0 silently (the protocol handshake probe)
 *   -z <prompt>      → streams a reply to stdout in chunks, then exits 0
 *
 * A prompt containing `SLOW_REPLY` writes one chunk and then stalls for 30s,
 * giving an HTTP cancel a real mid-flight window to land in.
 *
 * A prompt containing `FAIL_REPLY` streams a partial stdout fragment, writes a
 * diagnostic to stderr, and exits 3 — the wedge smoke's deterministic "the task
 * died" case, so honest failure visibility is provable without a real CLI
 * failing on cue.
 */
export async function fakeHermesPromptExecutable(version = '0.20.1') {
  const dir = await mkdtemp(join(tmpdir(), 'gate-fake-hermes-'));
  const script = join(dir, 'hermes.mjs');
  await writeFile(
    script,
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
const joined = argv.join(' ');
if (joined === '--version') {
  process.stdout.write(${JSON.stringify(version)} + '\\n');
  process.exit(0);
}
if (argv.includes('--acp')) {
  process.exit(0);
}
if (argv[0] === '-z') {
  const prompt = argv.slice(1).join(' ');
  if (prompt.includes('FAIL_REPLY')) {
    process.stdout.write('par');
    process.stderr.write('hermes: simulated failure: model unreachable\\n');
    process.exit(3);
  }
  const slow = prompt.includes('SLOW_REPLY');
  process.stdout.write('po');
  setTimeout(() => {
    process.stdout.write('ng\\n');
    if (!slow) process.exit(0);
    // Keep the child alive so a cancel has something to kill.
    setTimeout(() => process.exit(0), 30_000);
  }, slow ? 150 : 30);
} else {
  process.stderr.write('unexpected invocation: ' + joined + '\\n');
  process.exit(2);
}
`,
    'utf8',
  );
  await chmod(script, 0o755);
  return script;
}
