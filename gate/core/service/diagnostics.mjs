import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateCliEnvironmentRegistration } from '../cli-environments/schema.mjs';

/**
 * Read-only inspection of the CLI environment records under the Gate home.
 *
 * The known path-shredding corruption incident (2026-08) produced records that
 * sat on disk looking fine while every run against them failed — the schema
 * now rejects that class at the write path, but records written before the fix
 * (or by external tools) can still poison a pilot demo. `gate doctor` runs
 * these checks so an operator finds corruption in a health check, not mid-task.
 *
 * Findings are `{ severity, environment, message }` where severity is
 * 'error' (a record cannot work), 'warn' (suspicious but maybe intentional),
 * or 'ok' / 'info'. Only 'error' should flip the CLI exit code.
 */
export async function diagnoseEnvironmentRecords(environmentsDir) {
  let entries;
  try {
    entries = await readdir(environmentsDir);
  } catch {
    return [{
      severity: 'info',
      environment: null,
      message: `no environment records yet (${environmentsDir} does not exist)`,
    }];
  }

  const recordFiles = entries.filter((name) => name.endsWith('.json')).sort();
  if (recordFiles.length === 0) {
    return [{ severity: 'info', environment: null, message: 'no CLI environments registered yet' }];
  }

  const findings = [];
  for (const name of recordFiles) {
    findings.push(await diagnoseRecord(join(environmentsDir, name), name.slice(0, -'.json'.length)));
  }
  return findings;
}

async function diagnoseRecord(file, id) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    return { severity: 'error', environment: id, message: `record could not be read: ${error.message}` };
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return {
      severity: 'error',
      environment: id,
      message: 'record does not parse as JSON — restore it or re-register the environment',
    };
  }

  const validation = validateCliEnvironmentRegistration(record);
  if (!validation.ok) {
    const detail = validation.errors
      .slice(0, 2)
      .map((error) => `${error.field} ${error.message}`)
      .join('; ');
    const more = validation.errors.length > 2 ? ` (+${validation.errors.length - 2} more)` : '';
    return { severity: 'error', environment: id, message: `record failed validation: ${detail}${more}` };
  }

  if (!existsSync(record.executable.path)) {
    return {
      severity: 'error',
      environment: id,
      message: `executable.path does not exist on disk: ${record.executable.path}`
        + ' — runs will fail until it is fixed or the environment is re-registered',
    };
  }

  return { severity: 'ok', environment: id, message: `record valid, executable present (${record.adapterId})` };
}

/**
 * Is a Gate actually answering on this machine right now? The runbook's first
 * troubleshooting step is "confirm it answers locally" — this does it in one
 * command instead of asking the operator to reach for curl.
 */
export async function probeLocalGate(manifestUrl, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(manifestUrl);
    return response.ok
      ? { reachable: true, detail: `manifest answered ${response.status}` }
      : { reachable: false, detail: `listener responded ${response.status}` };
  } catch (error) {
    return { reachable: false, detail: error.message };
  }
}
