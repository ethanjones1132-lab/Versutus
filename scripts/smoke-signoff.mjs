// One-command sign-off evidence refresher.
//
// docs/commercial/pilot-signoff-evidence-matrix-v1.md turns the concierge-pilot
// acceptance checklist into evidence rows; its §E "refresh protocol" is the
// list of legs that must be green on sign-off day, and its §F log holds one
// dated row per refresh. This script IS §E as a single command: it runs the
// freshness legs against this machine and appends exactly ONE new row to §F,
// never editing an existing row (byte-level insert-only, proven before write).
//
// Usage:
//   npm run smoke:signoff                     # full §E: verify + portal + wedge + doctor + manifest
//   npm run smoke:signoff -- --no-verify      # quick refresh: portal + wedge + doctor + manifest
//   npm run smoke:signoff -- --with-real-cli  # additionally stamp the WEDGE_EXECUTABLE real-CLI pass
//   npm run smoke:signoff -- --dry-run        # compute + print the row, touch nothing
//
// Options:
//   --matrix <path>    matrix file (default docs/commercial/pilot-signoff-evidence-matrix-v1.md)
//   --gate-url <url>   production Gate base URL (default http://127.0.0.1:8760)
//
// Exit codes: 0 every requested leg green · 1 a leg went red (the red row is
// still appended — §D rule 3 wants failures logged, not hidden) · 2
// configuration error before any leg ran.
//
// The matrix lives under docs/commercial/ which is GITIGNORED BY DESIGN; this
// script writes disk only and never stages or commits anything.

import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MATRIX = path.join(REPO_ROOT, 'docs', 'commercial', 'pilot-signoff-evidence-matrix-v1.md');

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const optValue = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const NO_VERIFY = hasFlag('--no-verify');
const WITH_REAL_CLI = hasFlag('--with-real-cli');
const DRY_RUN = hasFlag('--dry-run');
const MATRIX_PATH = path.resolve(optValue('--matrix') ?? DEFAULT_MATRIX);
const GATE_URL = (optValue('--gate-url') ?? 'http://127.0.0.1:8760').replace(/\/+$/, '');
const WEDGE_EXECUTABLE = process.env.WEDGE_EXECUTABLE;

const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg) => console.log(`  FAIL  ${msg}`);

function dieConfig(message) {
  console.error(`smoke-signoff: configuration error — ${message}`);
  process.exit(2);
}

if (WITH_REAL_CLI && !WEDGE_EXECUTABLE && !DRY_RUN) {
  dieConfig('--with-real-cli needs WEDGE_EXECUTABLE set to the real CLI executable path (see matrix §C)');
}

/** Spawn one leg, capture output (capped), enforce a timeout. Never throws. */
async function runLeg(label, command, args, { timeoutMs, shell = false, env = undefined }) {
  console.log(`[${label}] running…`);
  const child = spawn(command, args, { cwd: REPO_ROOT, shell, windowsHide: true, env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill(); } catch { /* already gone */ }
  }, timeoutMs);
  const code = await new Promise((resolve) => {
    child.on('error', (e) => { stderr += `\n[spawn error] ${e.message}`; resolve(null); });
    child.on('close', (c) => resolve(c));
  });
  clearTimeout(timer);
  // Keep head (banner/config context) + tail (summaries live at the end).
  const HEAD = 2000;
  const TAIL = 14000;
  let output = stdout;
  if (output.length > HEAD + TAIL) {
    output = `${output.slice(0, HEAD)}\n…[truncated ${output.length - HEAD - TAIL} chars]…\n${output.slice(-TAIL)}`;
  }
  if (stderr.trim()) output += `\n--stderr--\n${stderr.slice(-4000)}`;
  if (timedOut) output += `\n[leg killed after ${Math.round(timeoutMs / 1000)}s timeout]`;
  const result = { label, code: code === null ? -1 : code, timedOut, output };
  if (code === 0 && !timedOut) ok(`${label} exited 0`);
  else {
    bad(`${label} exited ${code === null ? 'spawn-error' : code}${timedOut ? ' (timed out)' : ''}`);
    // Persist the FULL leg stdio (head+tail truncated only in the console
    // summary/row). A leg that dies with a Windows fail-fast code carries its
    // explanation in the tail — losing it made the 0xC0000409 recurrences
    // undiagnosable. Failures are rare; keeping the file on every red leg is
    // the diagnosis path for the next one.
    try {
      const dumpPath = path.join(
        tmpdir(),
        `signoff-leg-${label.replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}.log`,
      );
      await writeFile(dumpPath, `${output}\n`);
      console.log(`  dump  ${label} full stdio -> ${dumpPath}`);
    } catch (dumpError) {
      console.log(`  dump  ${label} stdio persist failed: ${dumpError.message}`);
    }
  }
  return result;
}

const lastInt = (text, re) => {
  const matches = [...text.matchAll(re)];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
};

async function legVerify() {
  const leg = await runLeg('verify', 'npm run verify', [], { shell: true, timeoutMs: 1_500_000 });
  const jestPassed = lastInt(leg.output, /Tests:\s*(\d+) passed/g);
  // node:test summary in either TAP (`# pass N`) or spec-reporter (`ℹ pass N`) form;
  // the gate suite runs last in the verify chain, so the LAST match is its count.
  const gatePassed = lastInt(leg.output, /^(?:#|ℹ)\s*pass\s+(\d+)/gm);
  const counts = [
    jestPassed !== null ? `jest ${jestPassed} passed` : null,
    gatePassed !== null ? `gate ${gatePassed} passed` : null,
  ].filter(Boolean);
  const cell = leg.code === 0 && !leg.timedOut
    ? `exit 0${counts.length ? ` (${counts.join(', ')})` : ''}`
    : `**FAILED** exit ${leg.code}${leg.timedOut ? '; timed out' : ''}`;
  return { ...leg, green: leg.code === 0 && !leg.timedOut, cell };
}

async function legPortal() {
  const leg = await runLeg('smoke:portal', 'npm run smoke:portal', [], { shell: true, timeoutMs: 300_000 });
  const allPass = leg.code === 0 && !leg.timedOut && /ALL PASS/.test(leg.output);
  return { ...leg, green: allPass, cell: allPass ? 'ALL PASS' : `**FAILED** exit ${leg.code}${leg.timedOut ? '; timed out' : ''}` };
}

async function legWedge(label, env) {
  const leg = await runLeg(label, 'node', ['scripts/smoke-wedge-loop.mjs'], { timeoutMs: env ? 900_000 : 600_000, env });
  // Final line reads e.g. "smoke-wedge-loop: PASS (11/11 wedge steps proven over
  // HTTP+SSE (hermetic))" — capture to end of line (nested parens included).
  const summaryMatch = leg.output.match(/smoke-wedge-loop: PASS \((.+)\)\s*$/m);
  const green = leg.code === 0 && !leg.timedOut && summaryMatch !== null;
  const fraction = summaryMatch ? (summaryMatch[1].match(/^\d+\/\d+/) ?? [null])[0] : null;
  return {
    ...leg,
    green,
    cell: green ? `PASS ${fraction ?? ''}`.trim() : `**FAILED** exit ${leg.code}${leg.timedOut ? '; timed out' : ''}`,
    // Evidentiary detail lines ("ok cancel — …", "ok time-limit — …") for the notes cell.
    details: [...leg.output.matchAll(/^\s{2}ok\s{4}(\S+)\s+—\s+(.+)$/gm)]
      .filter((m) => /cancel|time-limit|fail|deny|credential|restart|workspace|pong|stop/.test(m[0]))
      .map((m) => `${m[1]}: ${m[2].trim()}`)
      .slice(0, 14),
  };
}

async function legDoctor() {
  const leg = await runLeg('gate doctor', 'node', ['gate/cli.mjs', 'doctor'], { timeoutMs: 120_000 });
  const recordsOk = [...leg.output.matchAll(/^\s{2}(\S[^:]*):\s+ok\s+—/gm)].length;
  const serverLine = (leg.output.match(/^server:.*$/m) ?? [''])[0];
  return {
    ...leg,
    green: leg.code === 0 && !leg.timedOut,
    note: `${serverLine || `exit ${leg.code}`}${recordsOk ? ` (${recordsOk} env records ok)` : ''}`,
  };
}

async function legManifest() {
  console.log('[manifest] fetching…');
  try {
    const res = await fetch(`${GATE_URL}/.well-known/gateway.json`, { signal: AbortSignal.timeout(15_000) });
    const body = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* handled below */ }
    const good = res.status === 200 && parsed !== null && parsed.manifest === 'versutus-gateway/v1';
    if (good) ok(`manifest answered 200 versutus-gateway/v1 (${body.length} B)`);
    else bad(`manifest status ${res.status}, manifest field ${parsed ? String(parsed.manifest) : '<unparseable>'}`);
    return { green: good, cell: good ? `${res.status} versutus-gateway/v1` : `status ${res.status}`, note: `manifest ${res.status} (${body.length} B)` };
  } catch (e) {
    bad(`manifest unreachable at ${GATE_URL} — ${e.message}`);
    return { green: false, cell: '**FAILED** unreachable', note: `manifest unreachable: ${e.message}` };
  }
}

const cleanCell = (s) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const clipCell = (s, max) => (s.length <= max ? s : `${s.slice(0, max - 5)} […]`);

/**
 * Append ONE row line after the last data row of the §F table.
 * Insert-only by construction AND proven before writing: removing the inserted
 * line from the candidate must reproduce the original byte-for-byte, so no old
 * row can change. Mixed line endings are refused rather than normalized.
 */
export function appendRowToMatrix(original, rowLine) {
  const crlf = (original.match(/\r\n/g) ?? []).length;
  const lf = (original.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf > 0 && lf > 0) throw new Error('matrix file has mixed line endings; refusing to edit');
  const EOL = crlf > 0 ? '\r\n' : '\n';
  const lines = original.split(EOL);
  const headerIdx = lines.findIndex((l) => l.startsWith('| Date (UTC) |'));
  if (headerIdx === -1) throw new Error('§F stamped-runs header row not found');
  let lastRowIdx = -1;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (!lines[i].startsWith('|')) break;
    lastRowIdx = i;
  }
  if (lastRowIdx === -1) throw new Error('§F table has no data rows to append after');
  const insertAt = lastRowIdx + 1;
  const candidate = [...lines.slice(0, insertAt), rowLine, ...lines.slice(insertAt)].join(EOL);
  const proof = candidate.split(EOL);
  const foundAt = proof.indexOf(rowLine);
  if (foundAt !== insertAt) throw new Error('append-integrity: inserted row landed somewhere unexpected');
  proof.splice(foundAt, 1);
  if (proof.join(EOL) !== original) throw new Error('append-integrity: write would alter existing content');
  return candidate;
}

const gitOut = (args) => new Promise((resolve, reject) =>
  execFile('git', args, { cwd: REPO_ROOT }, (e, stdout) => (e ? reject(e) : resolve(stdout))));

async function main() {
  console.log(`smoke-signoff: matrix ${path.relative(REPO_ROOT, MATRIX_PATH)}`);
  console.log(`smoke-signoff: gate ${GATE_URL}${NO_VERIFY ? ' (--no-verify)' : ''}${WITH_REAL_CLI ? ' (--with-real-cli)' : ''}${DRY_RUN ? ' (--dry-run)' : ''}\n`);

  // Preflight: the matrix must exist. This script never creates it.
  let original;
  try {
    original = await readFile(MATRIX_PATH, 'utf8');
  } catch {
    dieConfig(`matrix file not found at ${MATRIX_PATH} — refusing to create it`);
  }

  let sha = 'unknown';
  let dirty = false;
  try {
    sha = (await gitOut(['rev-parse', '--short', 'HEAD'])).trim();
    dirty = (await gitOut(['status', '--porcelain'])).trim().length > 0;
  } catch {
    /* stamp as unknown */
  }
  console.log(`smoke-signoff: stamping commit ${sha}${dirty ? ' (+ uncommitted changes present)' : ''}\n`);

  const results = {};
  results.verify = DRY_RUN
    ? { green: null, cell: 'dry-run', skipped: true }
    : (NO_VERIFY ? { green: null, cell: 'skipped (--no-verify)', skipped: true } : await legVerify());
  results.portal = DRY_RUN ? { green: null, cell: 'dry-run', skipped: true } : await legPortal();
  // The hermetic pass must be deterministic-only: strip WEDGE_EXECUTABLE even if
  // the caller exported it, or this leg silently becomes a second real-CLI run.
  const hermeticEnv = { ...process.env };
  delete hermeticEnv.WEDGE_EXECUTABLE;
  results.wedgeHermetic = DRY_RUN ? { green: null, cell: 'dry-run', skipped: true, details: [] } : await legWedge('smoke:wedge hermetic', hermeticEnv);
  results.wedgeReal = WITH_REAL_CLI
    ? (DRY_RUN ? { green: null, cell: 'dry-run', skipped: true, details: [] }
       : await legWedge('smoke:wedge REAL CLI', { ...process.env, WEDGE_EXECUTABLE }))
    : { green: null, cell: 'not requested', skipped: true, details: [] };
  results.doctor = DRY_RUN ? { green: null, note: 'dry-run', skipped: true } : await legDoctor();
  results.manifest = DRY_RUN ? { green: null, cell: 'dry-run', note: 'dry-run', skipped: true } : await legManifest();

  const notes = [];
  if (results.wedgeHermetic.details?.length) notes.push(...results.wedgeHermetic.details.map((d) => `[hermetic] ${cleanCell(d)}`));
  if (results.wedgeReal.details?.length) notes.push(...results.wedgeReal.details.map((d) => `[real CLI] ${cleanCell(d)}`));
  if (!results.doctor.skipped) notes.push(`doctor exit ${results.doctor.code}: ${cleanCell(results.doctor.note ?? '')}`);
  if (!results.manifest.skipped) notes.push(cleanCell(results.manifest.note ?? ''));
  if (dirty) notes.push('stamp describes the working tree at this commit with uncommitted changes present');

  const dateUtc = new Date().toISOString().slice(0, 10);
  const rowLine = `| ${dateUtc} | ${sha}${dirty ? '-dirty' : ''} | ${cleanCell(results.verify.cell)} | ${cleanCell(results.portal.cell)} | ${cleanCell(results.wedgeHermetic.cell)} | ${cleanCell(results.wedgeReal.cell)} | ${clipCell(notes.join('; '), 1100) || '—'} |`;

  let nextContent = null;
  if (!DRY_RUN) {
    nextContent = appendRowToMatrix(original, rowLine);
  } else {
    try { appendRowToMatrix(original, rowLine); ok('dry-run: insert-only integrity check passed'); }
    catch (e) { bad(`dry-run: integrity check FAILED — ${e.message}`); process.exitCode = 2; return; }
  }

  console.log(`\nRow for §F:\n${rowLine}\n`);

  if (!DRY_RUN) {
    const backup = path.join(tmpdir(), `pilot-signoff-evidence-matrix-backup-${Date.now()}.md`);
    await copyFile(MATRIX_PATH, backup);
    await writeFile(MATRIX_PATH, nextContent, 'utf8');
    const reread = await readFile(MATRIX_PATH, 'utf8');
    if (reread !== nextContent) {
      bad('re-read of the matrix does not match what was written — restore from backup:');
      console.error(backup);
      process.exitCode = 1;
      return;
    }
    ok(`§F row appended (pre-write backup: ${backup})`);
  }

  const requested = [results.verify, results.portal, results.wedgeHermetic, results.wedgeReal, results.doctor, results.manifest]
    .filter((r) => !r.skipped);
  const red = requested.filter((r) => r.green === false);
  if (red.length) {
    console.log(`\nsmoke-signoff: RED on ${red.length}/${requested.length} requested legs — row recorded honestly; fix before sign-off (§D rule 3).`);
    process.exitCode = 1;
  } else {
    console.log(DRY_RUN
      ? '\nsmoke-signoff: DRY-RUN OK — insert-only integrity check passed; no legs ran, nothing written.'
      : `\nsmoke-signoff: PASS — all ${requested.length} requested legs green, row appended.`);
    process.exitCode = 0;
  }
}

main().catch((e) => {
  console.error(`smoke-signoff: unexpected failure — ${e.stack ?? e.message}`);
  process.exitCode = 2;
});
