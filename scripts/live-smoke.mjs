#!/usr/bin/env node
// Live smoke test for a RUNNING Gate (default http://127.0.0.1:8760).
//
// Why this exists: on 2026-10-01 a round of fixes was green in every unit test and
// still shipped a defect that broke every OpenCode turn, because the tests drove
// fakes that did not behave like the real server (the real OpenCode answers
// `prompt_async` with 204 and no body). Nothing here is a fake: it talks to the
// Gate over HTTP and the Gate talks to the real Hermes / OpenCode / Claude / Codex.
//
//   node scripts/live-smoke.mjs                 read-only checks (no model turns)
//   node scripts/live-smoke.mjs --turns         also run one tiny turn per environment
//   node scripts/live-smoke.mjs --turns --only opencode-local,hermes-local
//   node scripts/live-smoke.mjs --durable       the phone leaves mid-turn: the turn must still finish on the PC,
//                                               be readable from /v1/turns, replay, and answer a retry as resumed
//   node scripts/live-smoke.mjs --expect-bots 16
//   node scripts/live-smoke.mjs --token-file C:\Projects\Versutus\gate\.tokens.json   (from another worktree)
//
// Turns use FREE models only (an id containing "free", or the first model of a
// provider the operator named with --model <backendId>=<modelId>), and every
// session a turn created is deleted again. The Gate token is read from
// `gate/.tokens.json` and is never printed.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at !== -1 && argv[at + 1] ? argv[at + 1] : fallback;
};

const BASE = option('url', process.env.VERSUTUS_GATE_URL ?? 'http://127.0.0.1:8760').replace(/\/+$/, '');
const RUN_DURABLE = flag('durable');
const RUN_TURNS = flag('turns');
const ONLY = option('only', '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const EXPECT_BOTS = Number(option('expect-bots', '0')) || 0;
const TURN_TIMEOUT_MS = Number(option('turn-timeout', '150')) * 1000;
const PINNED = Object.fromEntries(
  argv
    .map((value, index) => (value === '--model' ? argv[index + 1] : null))
    .filter(Boolean)
    .map((pair) => pair.split('=')),
);

/** The bearer token, or a clear refusal. Never logged. */
export function readToken(path = option('token-file', process.env.VERSUTUS_GATE_TOKEN_FILE ?? join(HERE, '..', 'gate', '.tokens.json'))) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const token = typeof parsed === 'string' ? parsed : parsed?.token;
    if (typeof token === 'string' && token) return token;
  } catch {
    // fall through to the named refusal
  }
  throw new Error(`could not read a Gate token from ${path}`);
}

/** The model a smoke turn may use on an environment: pinned, else the first free one. */
export function pickSmokeModel(rows, backendId, pinned = PINNED) {
  const all = (rows ?? []).filter(Boolean);
  const named = pinned[backendId];
  // A model the operator names is smoked even when the Gate currently hides it:
  // that is the point of naming it.
  if (named) return all.find((row) => row.id === named || row.modelId === named) ?? null;
  const usable = all.filter((row) => row.available !== false && row.hidden !== true);
  return usable.find((row) => /free/i.test(String(row.id))) ?? null;
}

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  - ${detail}` : ''}`);
};
const skip = (name, why) => {
  results.push({ name, ok: true, skipped: true, detail: why });
  console.log(`skip  ${name}  - ${why}`);
};

async function call(token, path, { method = 'GET', body, timeoutMs = 60_000, headers = {} } = {}) {
  const started = Date.now();
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept-Encoding': 'gzip',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // fetch inflates a gzip body itself, so the text is already plain; the headers
  // still say what went over the wire.
  const raw = Buffer.from(await response.arrayBuffer());
  const encoded = response.headers.get('content-encoding') === 'gzip';
  const wire = Number(response.headers.get('content-length')) || raw.length;
  const text = raw.toString('utf8');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // an SSE or non-JSON body
  }
  return { status: response.status, ms: Date.now() - started, wire, text, json, encoded };
}

/** One streamed turn read the way the phone reads it; resolves with what arrived. */
async function streamedTurn(token, body) {
  const response = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-versutus-turn-id': `smoke-${Date.now().toString(36)}`,
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });
  const sessionId = response.headers.get('x-versutus-session-id');
  if (!response.ok) return { status: response.status, text: (await response.text()).slice(0, 300), deltas: 0, sessionId };
  let buffer = '';
  let deltas = 0;
  let reply = '';
  let error = null;
  for await (const chunk of response.body) {
    buffer += Buffer.from(chunk).toString('utf8');
    for (const line of buffer.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const frame = JSON.parse(payload);
        if (frame.error) error = frame.error.message ?? 'error';
        const delta = frame.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          deltas += 1;
          reply += delta;
        }
      } catch {
        // a partial frame; the next read completes it
      }
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
  }
  return { status: response.status, deltas, reply, error, sessionId };
}

/**
 * The phone leaving mid-turn, against the real Gate and the real backend.
 *
 * Starts a turn, reads until the first words arrive, then drops the connection
 * the way a phone going out of range does. The Gate must keep the turn running,
 * record it, finish it, replay it frame for frame, and answer a retry of the
 * same send as the same turn rather than starting a second one.
 */
async function durableTurn(token, id, model) {
  const turnId = `smoke-durable-${Date.now().toString(36)}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-versutus-turn-id': turnId };
  const body = JSON.stringify({
    model: model.id,
    backendId: id,
    stream: true,
    messages: [{ role: 'user', content: 'Count from one to twenty, one number per line, then stop.' }],
  });
  const controller = new AbortController();
  const response = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers, body, signal: controller.signal });
  const sessionId = response.headers.get('x-versutus-session-id');
  if (!response.ok) return { ok: false, detail: `HTTP ${response.status}`, sessionId };
  let sawWords = false;
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  try {
    for await (const chunk of response.body) {
      if (Buffer.from(chunk).toString('utf8').includes('"content"')) sawWords = true;
      if (sawWords || Date.now() > deadline) break;
    }
  } catch {
    // the stream failing before words is reported below
  }
  controller.abort();
  if (!sawWords) return { ok: false, detail: 'no words arrived before the phone left', sessionId };

  // The phone is gone. The turn must finish on its own.
  let meta = null;
  while (Date.now() < deadline) {
    const read = await call(token, `/v1/turns/${encodeURIComponent(turnId)}`).catch(() => null);
    meta = read?.json ?? null;
    if (meta && meta.status && meta.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (meta?.status !== 'done') return { ok: false, detail: `turn ended ${meta?.status ?? 'unknown'}${meta?.reason ? ` (${meta.reason})` : ''}, not done`, sessionId };
  if (!String(meta.text ?? '').trim()) return { ok: false, detail: 'turn is done but recorded no reply text', sessionId };

  const replay = await call(token, `/v1/turns/${encodeURIComponent(turnId)}/events?after=0`).catch(() => null);
  if (replay?.status !== 200 || !String(replay.text).includes('[DONE]')) {
    return { ok: false, detail: `replay answered HTTP ${replay?.status ?? 'no answer'} without [DONE]`, sessionId };
  }

  const retry = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers, body, signal: AbortSignal.timeout(60_000) });
  const resumed = retry.headers.get('x-versutus-turn-resumed') === '1';
  await retry.text().catch(() => '');
  if (!resumed) return { ok: false, detail: 'a retry of the same send did not come back as the same turn', sessionId };
  return { ok: true, detail: `survived the phone leaving: ${String(meta.text).trim().split(/\r?\n/).length} lines recorded, replayed, retry resumed`, sessionId };
}

async function main() {
  const token = readToken();

  const health = await call(token, '/health').catch((error) => ({ status: 0, text: String(error) }));
  record('gate answers /health', health.status === 200, `HTTP ${health.status}`);
  if (health.status !== 200) return;

  const bots = await call(token, '/v1/bots').catch(() => null);
  if (bots?.status === 200) {
    const list = bots.json?.data ?? [];
    const routable = list.filter((bot) => bot.routable !== false).length;
    record('bots listed', list.length > 0, `${routable}/${list.length} routable`);
    if (EXPECT_BOTS) record(`routable bots >= ${EXPECT_BOTS}`, routable >= EXPECT_BOTS, `${routable}`);
  } else {
    record('bots listed', false, `HTTP ${bots?.status ?? 'no answer'}`);
  }

  const manifest = await call(token, '/.well-known/gateway.json').catch(() => null);
  const environments = (manifest?.json?.backends ?? []).map((backend) => backend.id).filter(Boolean);
  record('manifest lists environments', environments.length > 0, environments.join(', '));

  const catalogue = await call(token, '/v1/models');
  record('aggregate model list', catalogue.status === 200 && (catalogue.json?.data?.length ?? 0) > 0,
    `${catalogue.json?.data?.length ?? 0} rows, ${catalogue.ms} ms, ${catalogue.wire} B on the wire${catalogue.encoded ? ' (gzip)' : ''}`);

  const created = [];
  for (const id of environments.filter((env) => !ONLY.length || ONLY.includes(env))) {
    const models = await call(token, `/v1/models?backendId=${encodeURIComponent(id)}`, { timeoutMs: 90_000 }).catch(() => null);
    const rows = models?.json?.data ?? [];
    record(`${id}: model list`, models?.status === 200 && rows.length > 0, models ? `HTTP ${models.status}, ${rows.length} rows, ${models.ms} ms` : 'no answer');
    if (models?.status !== 200) continue;

    const sessions = await call(token, `/v1/sessions?backendId=${encodeURIComponent(id)}&limit=5`, { timeoutMs: 90_000 }).catch(() => null);
    const list = sessions?.json?.data ?? [];
    record(`${id}: session list`, sessions?.status === 200, sessions ? `HTTP ${sessions.status}, ${list.length} rows, ${sessions.ms} ms` : 'no answer');

    if (list[0]?.id) {
      const restore = await call(token, '/v1/capabilities/rpc', {
        method: 'POST',
        body: { method: 'session.restore', params: { sessionId: list[0].id, backendId: id } },
        timeoutMs: 90_000,
      }).catch(() => null);
      record(`${id}: session.restore finds a listed session`, Boolean(restore?.json?.result?.id), restore ? `${restore.ms} ms` : 'no answer');
      const unscoped = await call(token, '/v1/capabilities/rpc', {
        method: 'POST',
        body: { method: 'session.restore', params: { sessionId: list[0].id } },
        timeoutMs: 90_000,
      }).catch(() => null);
      record(`${id}: session.restore with no scope still finds it`, Boolean(unscoped?.json?.result?.id), unscoped?.json?.error?.message ?? `${unscoped?.ms ?? '?'} ms`);
    }

    if (!RUN_TURNS && !RUN_DURABLE) continue;
    const model = pickSmokeModel(rows, id);
    if (!model) {
      skip(`${id}: turn`, 'no free model offered (pin one with --model <env>=<model>)');
      continue;
    }
    if (RUN_DURABLE) {
      const durable = await durableTurn(token, id, model).catch((error) => ({ ok: false, detail: String(error?.message ?? error) }));
      if (durable.sessionId) created.push({ id, sessionId: durable.sessionId });
      record(`${id}: a turn survives the phone leaving (${model.id})`, durable.ok, durable.detail);
      if (!RUN_TURNS) continue;
    }
    const turn = await streamedTurn(token, {
      model: model.id,
      backendId: id,
      messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }],
    }).catch((error) => ({ status: 0, error: String(error?.message ?? error), deltas: 0 }));
    if (turn.sessionId) created.push({ id, sessionId: turn.sessionId });
    const answered = turn.status === 200 && !turn.error && turn.deltas > 0;
    record(`${id}: streamed turn on ${model.id}`, answered,
      answered ? `${turn.deltas} deltas, reply "${String(turn.reply).trim().slice(0, 40)}"` : (turn.error ?? turn.text ?? `HTTP ${turn.status}`));
  }

  for (const { id, sessionId } of created) {
    await call(token, `/v1/sessions/${encodeURIComponent(sessionId)}?backendId=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
  }
  if (created.length) console.log(`cleanup: deleted ${created.length} smoke session(s)`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main()
    .catch((error) => record('smoke run', false, String(error?.message ?? error)))
    .finally(() => {
      const failed = results.filter((entry) => !entry.ok);
      console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
      process.exitCode = failed.length ? 1 : 0;
    });
}
