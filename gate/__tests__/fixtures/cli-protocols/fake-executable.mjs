import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function fakeExecutable(version, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gate-fake-cli-'));
  const script = join(dir, 'tool.mjs');
  const handshake = options.handshake ?? 'ok';
  await writeFile(script, `#!/usr/bin/env node
const arg = process.argv.slice(2).join(' ');
if (arg.includes('--version') || arg === 'version' || arg === '-v') {
  process.stdout.write(${JSON.stringify(version)} + '\\n');
  process.exit(0);
}
if (arg.includes('--acp') || /(^|\s)acp(\s|$)/.test(arg) || arg.includes('app-server') || arg.includes('--print0') || arg.includes('stream-json') || arg.includes('--output-format') || arg.includes('--format')) {
  process.stdout.write(${JSON.stringify(handshake)} + '\\n');
  process.exit(0);
}
process.stderr.write('unexpected invocation\\n');
process.exit(2);
`, 'utf8');
  await chmod(script, 0o755);
  return script;
}
