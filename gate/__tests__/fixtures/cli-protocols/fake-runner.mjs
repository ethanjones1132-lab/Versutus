import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A CLI whose non-interactive modes behave deterministically, so supervisor
 * tests exercise real child processes without shipping a real agent:
 *
 * - `--version`            prints the given version line, exits 0
 * - `<op-flag> PROMPT`     echoes the last argument back across two writes,
 *                          exits 0 (every adapter's prompt invocation ends
 *                          with the prompt as its final argument)
 * - PROMPT contains FAIL   writes to stderr, exits 3
 * - PROMPT contains SLEEP:n prints "working", stays alive n ms, exits 0
 */
export async function fakeRunner(version) {
  const dir = await mkdtemp(join(tmpdir(), 'gate-fake-runner-'));
  const script = join(dir, 'runner.mjs');
  await writeFile(script, `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write(${JSON.stringify(version)} + '\\n');
  process.exit(0);
}
const text = argv[argv.length - 1] ?? '';
if (/FAIL/.test(text)) {
  process.stderr.write('runner refused\\n');
  process.exit(3);
}
if (text.includes('SLEEP:')) {
  const ms = Number(/SLEEP:(\\d+)/.exec(text)[1]);
  process.stdout.write('working\\n');
  setTimeout(() => {
    process.stdout.write('done\\n');
    process.exit(0);
  }, ms);
} else {
  process.stdout.write('echo part 1: ');
  setTimeout(() => {
    process.stdout.write(text + '\\n');
    process.exit(0);
  }, 10);
}
`, 'utf8');
  await chmod(script, 0o755);
  return script;
}
