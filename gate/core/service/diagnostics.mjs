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
 *
 * @param {string} environmentsDir directory holding `<id>.json` records
 * @param {{ vault?: { get(ref: string): Promise<string|undefined> } }} [options]
 *   When a credential vault is passed, every `credentialBindings` reference is
 *   checked the same way `backend-manager.resolveCredentials` resolves them at
 *   run start — a bound reference with no value in the vault is silently inert
 *   at runtime, so doctor must say so before a demo, not after a failed task.
 */
export async function diagnoseEnvironmentRecords(environmentsDir, { vault } = {}) {
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
    findings.push(...(await diagnoseRecord(join(environmentsDir, name), name.slice(0, -'.json'.length), vault)));
  }
  return findings;
}

async function diagnoseRecord(file, id, vault) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    return [{ severity: 'error', environment: id, message: `record could not be read: ${error.message}` }];
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return [{
      severity: 'error',
      environment: id,
      message: 'record does not parse as JSON — restore it or re-register the environment',
    }];
  }

  const validation = validateCliEnvironmentRegistration(record);
  if (!validation.ok) {
    const detail = validation.errors
      .slice(0, 2)
      .map((error) => `${error.field} ${error.message}`)
      .join('; ');
    const more = validation.errors.length > 2 ? ` (+${validation.errors.length - 2} more)` : '';
    return [{ severity: 'error', environment: id, message: `record failed validation: ${detail}${more}` }];
  }

  if (!existsSync(record.executable.path)) {
    return [{
      severity: 'error',
      environment: id,
      message: `executable.path does not exist on disk: ${record.executable.path}`
        + ' — runs will fail until it is fixed or the environment is re-registered',
    }];
  }

  // The spawn runs with cwd = workspacePolicy.defaultRoot, so a root that is
  // not on disk fails every run as a bare "spawn ENOENT" — the same
  // first-demo killer doctor exists to catch in the executable. A missing
  // non-default root only matters when a run targets it, so that warns.
  const workspaceFindings = diagnoseWorkspaceRoots(record, id);
  const fatalWorkspace = workspaceFindings.filter((finding) => finding.severity === 'error');
  if (fatalWorkspace.length > 0) return fatalWorkspace;

  const base = `record valid, executable present (${record.adapterId})`;
  const bindingCheck = await diagnoseCredentialBindings(record, id, vault);
  return [
    {
      severity: 'ok',
      environment: id,
      message: bindingCheck.summary ? `${base}; ${bindingCheck.summary}` : base,
    },
    ...workspaceFindings,
    ...bindingCheck.warnings,
  ];
}

function diagnoseWorkspaceRoots(record, id) {
  const findings = [];
  const policy = record.workspacePolicy ?? {};
  if (policy.defaultRoot && !existsSync(policy.defaultRoot)) {
    findings.push({
      severity: 'error',
      environment: id,
      message: `workspacePolicy.defaultRoot does not exist on disk: ${policy.defaultRoot}`
        + ' — every run would fail to start; create the folder or fix the environment\u2019s workspace root',
    });
  }
  (policy.roots ?? []).forEach((root, index) => {
    if (root === policy.defaultRoot || existsSync(root)) return;
    findings.push({
      severity: 'warn',
      environment: id,
      message: `workspacePolicy.roots[${index}] does not exist on disk: ${root}`
        + ' — runs targeting it would fail; create the folder or remove it from the environment',
    });
  });
  return findings;
}

/**
 * Mirror of `backend-manager.resolveCredentials`: a binding "resolves" only
 * when the vault returns a non-empty string for its reference. Anything else
 * is inert at run start — the CLI spawns without that variable and fails
 * vendor auth later, which reads as a mysterious task failure. That is
 * suspicious-but-maybe-intentional (the key may be planned), so it warns
 * rather than erroring; the fix is in the message.
 */
async function diagnoseCredentialBindings(record, id, vault) {
  const bindings = Object.entries(record.credentialBindings ?? {});
  if (!vault || bindings.length === 0) return { summary: null, warnings: [] };

  const resolved = [];
  const inert = [];
  for (const [envName, ref] of bindings) {
    const value = await vault.get(ref).catch(() => undefined);
    if (typeof value === 'string' && value) resolved.push(envName);
    else inert.push({ envName, ref });
  }

  if (inert.length === 0) {
    return {
      summary: `${resolved.length} credential binding${resolved.length === 1 ? '' : 's'} resolve${resolved.length === 1 ? 's' : ''}`,
      warnings: [],
    };
  }
  return {
    summary: `${resolved.length} of ${bindings.length} credential bindings resolve`,
    warnings: inert.map(({ envName, ref }) => ({
      severity: 'warn',
      environment: id,
      message: `credential binding ${envName}=${ref} has no value in the vault`
        + ' — set the key from the Providers screen or remove the binding;'
        + ' runs would start without it and fail vendor auth',
    })),
  };
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
