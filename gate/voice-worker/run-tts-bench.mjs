import { spawn } from 'node:child_process';
import { voicePaths } from '../core/voice/runtime.mjs';

const paths = voicePaths();
const child = spawn(paths.python, [
  '-m', 'versutus_voice.tts_bench', '--models-dir', paths.models, ...process.argv.slice(2),
], { cwd: paths.worker, stdio: 'inherit' });
child.on('error', (error) => {
  console.error(`Could not run the Gate voice venv (${error.message}); run voice install first.`);
  process.exitCode = 1;
});
child.on('exit', (code) => { process.exitCode = code ?? 1; });
