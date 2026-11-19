// Stop the service first. This uses the real Gate home, adapters and worker,
// holding the same instance lock as `gate start`. Only recognition is injected.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { TextDecoderStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { resolveGateHome } from '../gate/core/paths.mjs';
import { createGate } from '../gate/core/server.mjs';
import { acquireInstanceLock } from '../gate/core/service/instance-lock.mjs';
import { PhoneSim } from './voice-live.mjs';

const root = fileURLToPath(new URL('../gate/', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const markerName = 'versutus-voice-approval-test.txt';
const textOf = (row) => typeof row?.content === 'string' ? row.content
  : (row?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');
const exists = (path) => access(path).then(() => true, (error) => {
  if (error.code !== 'ENOENT') throw error;
  return false;
});

async function main(argv) {
  const { values: args } = parseArgs({
    args: argv,
    options: {
      bot: { type: 'string' }, backend: { type: 'string' }, 'backend-id': { type: 'string' },
      session: { type: 'string' }, model: { type: 'string' }, text: { type: 'string' },
      expect: { type: 'string' }, 'approval-test': { type: 'boolean' },
      'typed-baseline': { type: 'boolean' },
      decision: { type: 'string', default: 'deny' }, 'scratch-root': { type: 'string' },
    },
  });
  assert.ok(['hermes', 'opencode', 'codex', 'claude-code'].includes(args.backend), 'Name the adapter with --backend.');
  assert.ok(args.bot, 'Name the Bot with --bot (use codex for configurable Codex).');
  assert.ok(args['approval-test'] ? args['scratch-root'] : args.text?.trim(),
    'Pass --text, or --approval-test with an existing disposable --scratch-root.');
  assert.ok(['approve', 'deny', 'expire'].includes(args.decision), 'Invalid --decision.');
  assert.ok(!args['approval-test'] || !args['typed-baseline'], 'Do not run a side effect as the typed baseline.');
  assert.notEqual(process.env.VERSUTUS_VOICE_SCRIPTED, '1', 'The real Kokoro worker is required.');

  const gateHome = resolveGateHome();
  const lock = await acquireInstanceLock(gateHome);
  let gate;
  let phone;
  let grant;
  let rpc;
  const device = { deviceId: `voice-backend-live-${randomUUID()}` };
  try {
    let engine;
    gate = await createGate({ root, gateHome, observeVoiceEngine(_session, live) { engine = live; } });
    const base = `http://127.0.0.1:${gate.port}`;
    async function request(path, body) {
      const res = await fetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${gate.token}`, 'Content-Type': 'application/json' },
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(45_000),
      });
      const payload = await res.json();
      if (!res.ok || payload.error) throw new Error(`${path}: ${payload.error?.code ?? res.status}`);
      return payload;
    }
    rpc = async (method, params) => (await request('/v1/capabilities/rpc', { method, params })).result;
    const { environments } = await rpc('environments.list', {});
    const matching = environments.filter((item) => item.enabled && item.adapterId === args.backend
      && (!args['backend-id'] || item.id === args['backend-id']));
    assert.equal(matching.length, 1, 'Select exactly one enabled environment (use --backend-id if ambiguous).');
    const backendId = matching[0].id;
    // `--bot -` drives a configurable backend (no named Bot), as Codex always is.
    const botId = args.backend === 'codex' || args.bot === '-' ? undefined : args.bot;
    const query = new URLSearchParams({ backendId, ...(botId ? { bot: botId } : {}) });
    // `--session new` creates a throwaway session inside this Gate, so a backend
    // whose fresh threads exist only in the creating process (Codex) can be
    // exercised without touching the Bot's real chat.
    const created = args.session === 'new'
      ? await request(`/v1/sessions?${query}`, { title: 'voice-parity test', backendId, ...(botId ? { bot: botId } : {}) })
      : null;
    const session = created
      ? created.data?.id ?? created.id ?? created.session?.id
      : args.session ?? (await request(`/v1/sessions?${query}`)).data
        .find((row) => row.title === 'Bot Chat')?.id;
    assert.ok(session, 'Pass --session for the native thread to exercise.');
    const history = async () => (await request(`/v1/sessions/${encodeURIComponent(session)}/messages?${query}`)).data;
    let typedFirstReplyTextMs;
    if (args['typed-baseline']) {
      const sent = performance.now();
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${gate.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stream: true, sessionId: session, backendId, bot: botId, model: args.model,
          messages: [{ role: 'user', content: args.text }],
        }),
        signal: AbortSignal.timeout(180_000),
      });
      assert.equal(res.status, 200, 'The typed baseline was refused.');
      let buffer = '';
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const value = line.startsWith('data: ') ? line.slice(6).trim() : '';
          if (!value || value === '[DONE]') continue;
          const payload = JSON.parse(value);
          assert.ok(!payload.error, 'The typed baseline failed.');
          if (typedFirstReplyTextMs === undefined && payload.choices?.[0]?.delta?.content) {
            typedFirstReplyTextMs = Math.round(performance.now() - sent);
          }
        }
      }
      assert.ok(Number.isFinite(typedFirstReplyTextMs), 'The typed baseline yielded no text.');
    }
    const before = new Set((await history()).map((row) => row.id));

    let text = args.text;
    let marker;
    let sentinel;
    if (args['approval-test']) {
      const scratch = await mkdtemp(join(args['scratch-root'], 'voice-approval-'));
      marker = join(scratch, markerName);
      sentinel = randomUUID();
      console.log(`Disposable fixture: ${marker}`);
      text = `Create exactly one file at ${JSON.stringify(marker)} containing exactly ${sentinel}. `
        + `${args.text ? `${args.text} ` : ''}Make only one attempt. If denied or expired, do not retry or use an alternate tool. `
        + 'Then tell me in one plain sentence whether the file was created.';
    }
    grant = await rpc('voice.session.start', {
      ...device, engine: 'local', disclosureAcceptedAt: new Date().toISOString(),
      thread: { kind: botId ? 'bot' : 'configurable', backendId, botId, sessionId: session, model: args.model },
    });
    assert.equal(grant.chatSessionId, session);
    assert.equal(grant.engine, 'local');
    const url = new URL(grant.streamPath, base.replace(/^http/, 'ws'));
    url.searchParams.set('voiceSessionId', grant.voiceSessionId);
    url.searchParams.set('protocol', '2');
    phone = new PhoneSim(url, { token: gate.token });
    await phone.open();
    await phone.waitFor(0, (event) => event.t === 'ready', 95_000, 'the warm local engine');
    assert.equal(engine?.id, 'local');

    const onset = performance.now();
    engine.emit('final', { text });
    const commit = await phone.waitFor(onset, (event) => event.t === 'final', 10_000, 'commit');
    assert.equal(commit.text, text.trim());
    const isTurn = (event) => event.turnId === commit.turnId;
    let pending;
    if (marker) {
      pending = await phone.waitFor(commit.at, (event) => isTurn(event)
        && (event.t === 'approval' && event.state === 'pending' || event.t === 'turn' && ['done', 'failed'].includes(event.state)),
      180_000, 'a native approval');
      assert.equal(await exists(marker), false, 'The file was created before the approval decision.');
      assert.equal(pending.t, 'approval', 'This backend/config did not raise an approval for this action.');
      assert.equal(pending.gateDecision, true);
      const inbox = await rpc('approvals.pending', {});
      assert.ok(inbox.approvals.some((card) => card.approvalId === pending.approvalId));
      console.log(`Pending ${pending.approvalId}: ${pending.summary}`);
      if (args.decision !== 'expire') {
        await rpc(`approval.${args.decision}`, { approvalId: pending.approvalId });
      }
      const expected = { approve: 'approved', deny: 'denied', expire: 'expired' }[args.decision];
      const settled = await phone.waitFor(pending.at, (event) => event.t === 'approval'
        && event.approvalId === pending.approvalId && event.state !== 'pending', 40_000, 'the Gate decision');
      assert.equal(settled.state, expected);
      const ledger = await readFile(join(gateHome, 'approvals', 'decisions.jsonl'), 'utf8');
      const decision = ledger.trim().split('\n').map(JSON.parse).find((entry) => entry.approvalId === pending.approvalId);
      assert.equal(decision?.decision, expected);
      assert.equal(decision.source, 'voice');
      assert.equal(decision.backend, backendId);
      console.log(JSON.stringify({ decision }));
    }
    const done = await phone.waitFor(commit.at, (event) => isTurn(event)
      && event.t === 'turn' && ['done', 'failed'].includes(event.state), 180_000, 'turn completion');
    assert.equal(done.state, 'done', done.error);
    const replyFrames = phone.events.filter((event) => isTurn(event) && event.t === 'reply');
    const reply = replyFrames.map((event) => event.delta).join('');
    assert.ok(reply.trim(), 'The Bot returned no text.');
    assert.doesNotMatch(reply, /use typed chat for actions|this pc.s managed claude settings/i);
    if (args.expect) assert.ok(reply.includes(args.expect), 'The reply did not contain --expect.');
    const deadline = performance.now() + 15_000;
    while (!phone.audio.some((frame) => frame.at >= commit.at) && performance.now() < deadline) await sleep(20);
    const pcm = phone.audio.find((frame) => frame.at >= commit.at);
    assert.ok(pcm, 'No PCM reached the live media socket.');
    if (marker) {
      if (args.decision === 'approve') assert.equal((await readFile(marker, 'utf8')).trim(), sentinel);
      else assert.equal(await exists(marker), false, 'The file exists despite denial or expiry.');
    }
    let rows;
    for (let attempt = 0; attempt < 5; attempt++) {
      rows = (await history()).filter((row) => !before.has(row.id));
      if (rows.some((row) => row.role === 'assistant' && textOf(row).trim())) break;
      await sleep(200);
    }
    assert.deepEqual(rows.filter((row) => row.role === 'user').map(textOf).filter(Boolean), [commit.text]);
    assert.equal(rows.filter((row) => row.role === 'assistant').map(textOf).join('').trim(), reply.trim());
    console.log(JSON.stringify({
      backendId, session, typedFirstReplyTextMs, commitToFirstReplyTextMs: Math.round(replyFrames[0].at - commit.at),
      commitToFirstPcmMs: Math.round(pcm.at - commit.at), firstPcmMayBeApproval: Boolean(pending), reply,
    }, null, 2));
  } finally {
    if (grant) await rpc('voice.session.stop', { ...device, voiceSessionId: grant.voiceSessionId, reason: 'harness' }).catch(() => {});
    phone?.close();
    try { await gate?.close(); } finally { await lock.release(); }
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
