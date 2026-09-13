/**
 * M1 S1 — does `codex app-server` offer realtime voice on the ChatGPT login, from
 * a third-party client, on Windows?
 *
 * This is a spike, not product code. It spawns the app-server twice (with and
 * without `features.realtime_conversation=true`), asks the experimental realtime
 * questions from docs/plans/2026-09-12-realtime-voice-plan.md §M1 S1, and writes
 * one JSONL line per request/result/notification to docs/plans/voice-spikes/.
 * Nothing here is imported by the app or the Gate.
 *
 * Usage: node scripts/voice-spikes/s1-codex-realtime.mjs [--out <path>]
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStdioJsonRpc } from '../../gate/core/cli-environments/jsonrpc-stdio.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const isWindows = process.platform === 'win32';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outArgIndex = process.argv.indexOf('--out');
const outPath =
  outArgIndex > -1 && process.argv[outArgIndex + 1]
    ? resolve(process.argv[outArgIndex + 1])
    : join(repoRoot, 'docs', 'plans', 'voice-spikes', `s1-${stamp}.jsonl`);

const capture = [];
let currentRun = 'setup';

function record(event, data) {
  capture.push({ ts: new Date().toISOString(), run: currentRun, event, ...data });
  const line = data && (data.method || data.message);
  process.stdout.write(`[s1] ${currentRun} ${event}${line ? ` ${line}` : ''}\n`);
}

/** A 1 s, 440 Hz, 16-bit mono PCM tone, no WAV header (appendAudio wants raw PCM). */
function tonePcm(sampleRate, seconds = 1, freq = 440) {
  const samples = Math.floor(sampleRate * seconds);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.2 * 32767), i * 2);
  }
  return buf;
}

function spawnAppServer(configArgs) {
  const args = [...configArgs, 'app-server'];
  if (isWindows) {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'codex', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
  return spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

function killTree(child) {
  try {
    if (isWindows && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch {
    // the process is already gone
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function threadIdOf(result) {
  return result?.thread?.id ?? result?.threadId ?? result?.id ?? null;
}

async function runOne(label, configArgs) {
  currentRun = label;
  const child = spawnAppServer(configArgs);
  let rpc;
  rpc = createStdioJsonRpc({
    child,
    onNotification: (message) => record('notification', { method: message.method, params: message.params }),
    onServerRequest: (message) => {
      record('server-request', { method: message.method, params: message.params });
      return {};
    },
    onDiagnostic: ({ message }) => record('diagnostic', { message }),
  });

  async function ask(method, params, timeoutMs = 30_000) {
    record('request', { method, params });
    try {
      const result = await rpc.request(method, params, { timeoutMs });
      record('result', { method, result });
      return result;
    } catch (error) {
      record('error', { method, message: error?.message ?? String(error) });
      return null;
    }
  }

  try {
    await ask('initialize', {
      clientInfo: { name: 'versutus-voice-spike', version: '0.0.1' },
      capabilities: { experimentalApi: true },
    });

    const voices = await ask('thread/realtime/listVoices', {});
    record('note', { voicesPresent: Boolean(voices) });

    const thread = await ask('thread/start', {
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      cwd: voiceWorkspace(),
    });
    const threadId = threadIdOf(thread);
    record('note', { threadId });

    if (!threadId) {
      record('note', { skipped: 'no threadId; cannot start realtime' });
      return;
    }

    await ask('thread/realtime/start', {
      threadId,
      outputModality: 'audio',
      transport: { type: 'websocket' },
      clientManagedHandoffs: true,
      includeStartupContext: false,
    });

    for (const sampleRate of [24000, 16000]) {
      await ask('thread/realtime/appendAudio', {
        threadId,
        audio: {
          data: tonePcm(sampleRate).toString('base64'),
          numChannels: 1,
          sampleRate,
        },
      });
    }

    await ask('thread/realtime/appendSpeech', { threadId, text: 'Versutus voice check.' });
    await sleep(2000);
    await ask('thread/realtime/stop', { threadId });
  } catch (error) {
    record('fatal', { message: error?.message ?? String(error) });
  } finally {
    try {
      rpc.close();
    } catch {
      // already closed
    }
    killTree(child);
  }
}

function voiceWorkspace() {
  const base = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || repoRoot, 'AppData', 'Local');
  const dir = join(base, 'Versutus', 'Gate', 'voice', 'codex-workspace');
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  record('start', { out: outPath, platform: process.platform });
  await runOne('withoutFlag', []);
  await runOne('withFlag', ['-c', 'features.realtime_conversation=true']);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${capture.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  process.stdout.write(`[s1] wrote ${capture.length} entries to ${outPath}\n`);
}

main().catch((error) => {
  record('fatal', { message: error?.stack ?? String(error) });
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${capture.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  } catch {
    // best effort
  }
  process.exitCode = 1;
});
