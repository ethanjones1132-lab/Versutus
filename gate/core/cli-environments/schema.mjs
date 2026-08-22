const SCHEMA_VERSION = 1;
const KIND = 'cli-environment';
const ADAPTERS = new Set(['hermes', 'codex', 'claude-code', 'opencode']);
const PROTOCOLS = new Set(['acp', 'mcp', 'app_server', 'jsonl', 'conpty']);
const SANDBOXES = new Set(['read_only', 'workspace_write', 'isolated_worktree']);
const STARTUPS = new Set(['on_demand', 'persistent']);
const TOP_FIELDS = new Set([
  'schemaVersion',
  'kind',
  'id',
  'label',
  'adapterId',
  'executable',
  'protocolPreference',
  'versionPolicy',
  'providerRefs',
  'workspacePolicy',
  'lifecycle',
  'enabled',
  // Operator-bound credential vault references (env var name -> vault ref),
  // resolved by backend-manager.resolveCredentials at backend start. The
  // schema previously rejected this field while the runtime read it, so any
  // re-save of a bound record either dropped the binding or failed validation.
  'credentialBindings',
]);
const FORBIDDEN = new Set([
  'credentials',
  'tokens',
  'catalog',
  'models',
  'credentialRef',
  'oauthProfileId',
  'apiKey',
  'apiKeyEnv',
  'access_token',
  'refresh_token',
  'auth',
  'registration',
]);

function err(errors, field, message) {
  errors.push({ field, message });
}

function requireObject(value, field, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(errors, field || 'value', 'must be an object');
    return false;
  }
  return true;
}

function requireString(value, field, errors) {
  if (typeof value !== 'string' || value.length === 0) {
    err(errors, field, 'must be a non-empty string');
    return false;
  }
  return true;
}

/**
 * The known path-shredding corruption incident (2026-08): a Windows path was
 * written with its backslashes dropped and escape sequences evaluated, leaving
 * control characters (e.g. \u000b from "\venv") where folder names should be.
 * Such records pass "is a string" checks but can never execute. Any C0 control
 * character or DEL in a path is that signature — reject it at the write path.
 */
export function containsControlCharacter(value) {
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function requirePath(value, field, errors) {
  if (!requireString(value, field, errors)) return false;
  if (containsControlCharacter(value)) {
    err(
      errors,
      field,
      'contains control characters — the record looks corrupted by the known '
        + 'path-shredding incident; re-register with the plain Windows path',
    );
    return false;
  }
  return true;
}

function rejectUnknown(object, allowed, prefix, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      const field = prefix ? `${prefix}.${key}` : key;
      err(errors, field, FORBIDDEN.has(key) ? 'provider state is not allowed on a CLI environment' : 'is not allowed');
    }
  }
}

export function validateCliEnvironmentRegistration(value) {
  const errors = [];
  if (!requireObject(value, 'value', errors)) {
    return { ok: false, errors };
  }

  rejectUnknown(value, TOP_FIELDS, '', errors);

  if (value.schemaVersion !== SCHEMA_VERSION) {
    err(errors, 'schemaVersion', `must be ${SCHEMA_VERSION}`);
  }
  if (value.kind !== KIND) {
    err(errors, 'kind', `must be '${KIND}'`);
  }
  requireString(value.id, 'id', errors);
  requireString(value.label, 'label', errors);
  if (!ADAPTERS.has(value.adapterId)) {
    err(errors, 'adapterId', `must be one of [${[...ADAPTERS].join(', ')}]`);
  }
  if (typeof value.enabled !== 'boolean') {
    err(errors, 'enabled', 'must be a boolean');
  }

  if (requireObject(value.executable, 'executable', errors)) {
    rejectUnknown(value.executable, new Set(['path', 'expectedPublisher']), 'executable', errors);
    requirePath(value.executable.path, 'executable.path', errors);
    if (value.executable.expectedPublisher !== undefined) {
      requireString(value.executable.expectedPublisher, 'executable.expectedPublisher', errors);
    }
  }

  if (!Array.isArray(value.protocolPreference) || value.protocolPreference.length === 0) {
    err(errors, 'protocolPreference', 'must be a non-empty array');
  } else {
    value.protocolPreference.forEach((protocol, index) => {
      if (!PROTOCOLS.has(protocol)) {
        err(errors, `protocolPreference[${index}]`, `must be one of [${[...PROTOCOLS].join(', ')}]`);
      }
    });
  }

  if (requireObject(value.versionPolicy, 'versionPolicy', errors)) {
    rejectUnknown(value.versionPolicy, new Set(['supported', 'adapterRevision']), 'versionPolicy', errors);
    requireString(value.versionPolicy.supported, 'versionPolicy.supported', errors);
    requireString(value.versionPolicy.adapterRevision, 'versionPolicy.adapterRevision', errors);
  }

  if (!Array.isArray(value.providerRefs)) {
    err(errors, 'providerRefs', 'must be an array of provider ids');
  } else {
    value.providerRefs.forEach((id, index) => requireString(id, `providerRefs[${index}]`, errors));
  }

  if (requireObject(value.workspacePolicy, 'workspacePolicy', errors)) {
    rejectUnknown(
      value.workspacePolicy,
      new Set(['roots', 'defaultRoot', 'defaultSandbox', 'allowAdditionalRoots']),
      'workspacePolicy',
      errors,
    );
    if (!Array.isArray(value.workspacePolicy.roots) || value.workspacePolicy.roots.length === 0) {
      err(errors, 'workspacePolicy.roots', 'must be a non-empty array');
    } else {
      value.workspacePolicy.roots.forEach((root, index) => requirePath(root, `workspacePolicy.roots[${index}]`, errors));
    }
    requirePath(value.workspacePolicy.defaultRoot, 'workspacePolicy.defaultRoot', errors);
    if (!SANDBOXES.has(value.workspacePolicy.defaultSandbox)) {
      err(errors, 'workspacePolicy.defaultSandbox', `must be one of [${[...SANDBOXES].join(', ')}]`);
    }
    if (typeof value.workspacePolicy.allowAdditionalRoots !== 'boolean') {
      err(errors, 'workspacePolicy.allowAdditionalRoots', 'must be a boolean');
    }
  }

  if (requireObject(value.lifecycle, 'lifecycle', errors)) {
    rejectUnknown(value.lifecycle, new Set(['startup', 'idleTimeoutSeconds', 'maxConcurrentRuns']), 'lifecycle', errors);
    if (!STARTUPS.has(value.lifecycle.startup)) {
      err(errors, 'lifecycle.startup', `must be one of [${[...STARTUPS].join(', ')}]`);
    }
    if (!Number.isInteger(value.lifecycle.idleTimeoutSeconds) || value.lifecycle.idleTimeoutSeconds < 0) {
      err(errors, 'lifecycle.idleTimeoutSeconds', 'must be a non-negative integer');
    }
    if (!Number.isInteger(value.lifecycle.maxConcurrentRuns) || value.lifecycle.maxConcurrentRuns < 1) {
      err(errors, 'lifecycle.maxConcurrentRuns', 'must be a positive integer');
    }
  }

  // Bindings hold vault REFERENCES, never secret material: env var name ->
  // vault ref (e.g. "environment/hermes-local/api-key"). Structural check only.
  if (value.credentialBindings !== undefined && requireObject(value.credentialBindings, 'credentialBindings', errors)) {
    for (const [envName, ref] of Object.entries(value.credentialBindings)) {
      if (!requireString(ref, `credentialBindings.${envName}`, errors)) continue;
      if (typeof envName !== 'string' || envName.length === 0) {
        err(errors, 'credentialBindings', 'keys must be non-empty environment variable names');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
