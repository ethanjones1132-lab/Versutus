#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const timeoutMs = Number(process.env.OPENCLAW_COMMAND_TIMEOUT_MS ?? 3500);
const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

const checks = [
  { slash: '/health', method: 'health' },
  { slash: '/status', method: 'status' },
  { slash: '/sessions', method: 'sessions.list', params: { limit: 10 } },
  { slash: '/channels', method: 'channels.status' },
  { slash: '/usage', method: 'usage.status' },
  { slash: '/cost', method: 'usage.cost' },
  { slash: '/stability', method: 'diagnostics.stability' },
  { slash: '/logs', method: 'logs.tail', params: { limit: 20, maxBytes: 12000 } },
  { slash: '/models', method: 'models.list' },
  { slash: '/model', method: 'config.get' },
  { slash: '/model auth', method: 'models.authStatus' },
  { slash: '/config', method: 'config.get' },
  { slash: '/plugins', method: 'plugins.uiDescriptors' },
  { slash: '/approvals', method: 'exec.approvals.get', scopeLimited: true },
  { slash: '/memory', method: 'doctor.memory.status' },
  { slash: '/skills', method: 'skills.status' },
  { slash: '/env', method: 'environments.status' },
  { slash: '/cron', method: 'cron.status' },
];

const rows = [];

for (const check of checks) {
  const started = Date.now();
  const result = await callGateway(check);
  rows.push({
    ...check,
    durationMs: Date.now() - started,
    ...result,
  });
}

const failed = rows.filter((row) => row.status === 'fail');
const skipped = rows.filter((row) => row.status === 'scope');
const passed = rows.filter((row) => row.status === 'pass');

for (const row of rows) {
  const label = row.status.toUpperCase().padEnd(5);
  const duration = `${row.durationMs}ms`.padStart(7);
  const suffix = row.note ? ` - ${row.note}` : '';
  console.log(`${label} ${duration} ${row.slash.padEnd(13)} ${row.method}${suffix}`);
}

console.log('');
console.log(`Gateway command smoke: ${passed.length} passed, ${skipped.length} scope-limited, ${failed.length} failed`);

if (failed.length > 0) {
  process.exitCode = 1;
}

function callGateway(check) {
  return new Promise((resolve) => {
    const args = [
      'gateway',
      'call',
      check.method,
      '--json',
      '--timeout',
      String(timeoutMs),
      '--params',
      JSON.stringify(check.params ?? {}),
    ];

    if (gatewayUrl) args.push('--url', gatewayUrl);
    if (gatewayToken) args.push('--token', gatewayToken);

    const command = resolveOpenClawCommand(args);
    const child = spawn(command.executable, command.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ status: 'fail', note: `timed out after ${timeoutMs + 1500}ms` });
    }, timeoutMs + 1500);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve({ status: 'fail', note: error.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      const output = `${stdout}\n${stderr}`.trim();
      const cleanOutput = redactSecrets(output);
      if (code === 0) {
        const parsed = parseMaybeJson(stdout);
        const note = parsed ? summarizePayload(parsed) : 'completed';
        resolve({ status: 'pass', note });
        return;
      }

      if (check.scopeLimited && /(scope|unauthor|forbidden|permission|denied)/i.test(cleanOutput)) {
        resolve({ status: 'scope', note: compactLine(cleanOutput) });
        return;
      }

      resolve({ status: 'fail', note: compactLine(cleanOutput || `exit ${code}`) });
    });
  });
}

function resolveOpenClawCommand(args) {
  if (process.platform === 'win32' && process.env.APPDATA) {
    const cliPath = join(process.env.APPDATA, 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');
    if (existsSync(cliPath)) {
      return { executable: process.execPath, args: [cliPath, ...args] };
    }
  }

  return { executable: 'openclaw', args };
}

function parseMaybeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function summarizePayload(value) {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (!value || typeof value !== 'object') return 'completed';
  const record = value;
  const keys = ['status', 'state', 'ok', 'version', 'method'];
  const summary = keys
    .filter((key) => Object.prototype.hasOwnProperty.call(record, key))
    .map((key) => `${key}=${String(record[key])}`)
    .join(', ');
  return summary || `${Object.keys(record).length} keys`;
}

function compactLine(value) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function redactSecrets(value) {
  return value
    .replace(/(--token\s+)(\S+)/gi, '$1[redacted]')
    .replace(/("token"\s*:\s*")([^"]+)(")/gi, '$1[redacted]$3')
    .replace(/(Bearer\s+)([A-Za-z0-9._-]+)/gi, '$1[redacted]');
}
