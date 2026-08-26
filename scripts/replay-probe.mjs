// Replay-of-completed probe — ships with the repo so the buyer sign-off sheet's
// evidence step (packet §6 step 7) runs from any checkout, not just this
// machine. Proves a finished run replays its exact event stream from sequence 1:
//   1. POST /v1/runs {input:'Reply with exactly: pong'}   (unpinned backend by
//      default — the shipped client shape; pass argv[2] to pin explicitly)
//   2. live GET /v1/runs/:id/events — answers any approval card, reads to end
//   3. after completion, REPLAYS /v1/runs/:id/events and asserts a 200
//      event-stream identical to the live frames — the seam that used to fail
//      completed-run replays before the Gate archived run streams to disk.
//
// Usage: npm run smoke:replay -- [baseUrl] [backendId]
// Token: reads the Gate token from gate/.tokens.json (printed by `gate start`;
// never committed).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8760';
const EXPLICIT_BACKEND = process.argv[3] ?? '';
const token = JSON.parse(
  readFileSync(join(process.cwd(), 'gate', '.tokens.json'), 'utf8'),
).token;
if (!token) throw new Error('no token in gate/.tokens.json');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
};

const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

// Tolerant SSE reader: LF or CRLF line endings, `event:`/`data:` fields,
// blank-line frame boundaries, comment lines ignored.
async function readSse(res, maxMs = 150_000) {
  const frames = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let cur = null;
  const flush = () => {
    if (cur && (cur.event || cur.data.length > 0)) {
      frames.push({ event: cur.event, data: cur.data.join('\n') });
    }
    cur = null;
  };
  const handleLine = (raw) => {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      flush();
      return;
    }
    if (line.startsWith(':')) return;
    const m = line.match(/^(event|data):\s?(.*)$/);
    if (!m) return;
    cur ??= { event: '', data: [] };
    if (m[1] === 'event') cur.event = m[2];
    else cur.data.push(m[2]);
  };
  const deadline = Date.now() + maxMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error('sse timeout');
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf !== '') handleLine(buf);
  flush();
  return frames;
}

const kinds = (frames) =>
  frames.map((f) => {
    try {
      const d = JSON.parse(f.data ?? '{}');
      return d.type ?? d.event ?? (f.event || '?');
    } catch {
      return f.event || '?';
    }
  });

const promptBody = EXPLICIT_BACKEND
  ? { input: 'Reply with exactly: pong', backendId: EXPLICIT_BACKEND }
  : { input: 'Reply with exactly: pong' };

console.log(`POST ${BASE}/v1/runs ${EXPLICIT_BACKEND ? `(backendId=${EXPLICIT_BACKEND})` : '(unpinned)'}`);
const startedRes = await fetch(`${BASE}/v1/runs`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify(promptBody),
});
check('runs.create 200', startedRes.ok, `status=${startedRes.status}`);
const started = await startedRes.json().catch(() => ({}));
const runId = started.run_id ?? started.id ?? started.runId;
check('run_id returned', typeof runId === 'string' && runId.length > 0, JSON.stringify(started).slice(0, 200));

if (typeof runId !== 'string' || runId.length === 0) {
  console.log(`\nREPLAY PROBE: ${failures + 1} FAILURE(S) — no run to stream`);
  process.exitCode = 1;
  process.exit(1);
}

console.log('live stream:');
let liveFrames = [];
try {
  const eventsUrl = `${BASE}/v1/runs/${encodeURIComponent(runId)}/events`;
  const liveRes = await fetch(eventsUrl, { headers: { Authorization: `Bearer ${token}` } });
  check('live events 200', liveRes.ok, `status=${liveRes.status}`);

  // Read with an approval-answerer riding along: an approval.required frame
  // holds the run until answered (2-min timeout would deny it).
  const reader = liveRes.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let cur = null;
  let approved = false;
  const flushLive = () => {
    if (cur && (cur.event || cur.data.length > 0)) {
      liveFrames.push({ event: cur.event, data: cur.data.join('\n') });
    }
    cur = null;
  };
  const handleLiveLine = (raw) => {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      flushLive();
      return;
    }
    if (line.startsWith(':')) return;
    const m = line.match(/^(event|data):\s?(.*)$/);
    if (!m) return;
    cur ??= { event: '', data: [] };
    if (m[1] === 'event') cur.event = m[2];
    else cur.data.push(m[2]);
  };
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('live sse timeout');
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      handleLiveLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (liveFrames.length > 0 && !approved && (liveFrames.at(-1).data ?? '').includes('approval.required')) {
        approved = true;
        const ansRes = await fetch(`${BASE}/v1/runs/${encodeURIComponent(runId)}/approval`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ approved: true }),
        });
        check('approval card answered', ansRes.ok, `status=${ansRes.status}`);
      }
    }
  }
} catch (e) {
  check('live stream completes', false, String(e));
}

console.log(`  live frames: ${liveFrames.length} [${kinds(liveFrames).join(', ')}]`);
check('live stream reached run.completed', kinds(liveFrames).includes('run.completed'));
const completedFrame = liveFrames.find((f) => kinds([f])[0] === 'run.completed');
// Hermes-kind agentic streams close with an output-bearing run.completed
// (no exitCode); CLI-environment streams carry exitCode instead.
let liveVerdict = false;
try {
  const d = JSON.parse(completedFrame?.data ?? '{}');
  liveVerdict =
    d.exitCode === 0 ||
    d.exit_code === 0 ||
    String(d.output ?? '').length > 0;
} catch {
  liveVerdict = false;
}
check('live completed carries a terminal verdict', liveVerdict);
check('live output mentions pong', liveFrames.some((f) => (f.data ?? '').includes('pong')));

await new Promise((r) => setTimeout(r, 1500)); // archive finalize + completeness marker

console.log('replay of the COMPLETED run (the case that used to 500):');
const repRes = await fetch(`${BASE}/v1/runs/${encodeURIComponent(runId)}/events`, {
  headers: { Authorization: `Bearer ${token}` },
});
check('replay status 200', repRes.status === 200, `status=${repRes.status} type=${repRes.headers.get('content-type')}`);
check('replay is event-stream', (repRes.headers.get('content-type') ?? '').includes('event-stream'));
let repFrames = [];
try {
  repFrames = await readSse(repRes);
} catch (e) {
  check('replay readable', false, String(e));
}
console.log(`  replay frames: ${repFrames.length} [${kinds(repFrames).join(', ')}]`);
check('replay non-empty', repFrames.length > 0);
check(
  'replay first frame matches live first frame',
  kinds(repFrames)[0] === kinds(liveFrames)[0],
  `${kinds(repFrames)[0]} vs ${kinds(liveFrames)[0]}`,
);
check('replay reaches run.completed', kinds(repFrames).includes('run.completed'));
check('replay sequence identical to live', JSON.stringify(kinds(repFrames)) === JSON.stringify(kinds(liveFrames)));

console.log(`runId=${runId}`);
console.log(failures === 0 ? '\nREPLAY PROBE: ALL PASS' : `\nREPLAY PROBE: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
