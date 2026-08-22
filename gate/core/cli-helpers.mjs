/** Validate a kind id or instance id (lowercase alphanumeric + hyphens). Both use
 *  the same rule — instance ids are filenames, kind ids are directory names,
 *  and gate/registry/ is a flat namespace either way. */
export function validateId(id) {
  return Boolean(id) && /^[a-z0-9-]+$/.test(id);
}

/** A type-appropriate placeholder value for a field with no declared default —
 *  what a newly-scaffolded instance's config gets before it's filled in. */
export function templateValueForField(field) {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case 'string-list':
      return [];
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'enum':
      return field.options?.[0] ?? '';
    case 'secret-ref':
      return 'ENV_VAR_NAME_HERE';
    case 'string':
    default:
      return '';
  }
}

/** Build a new instance's config object from a kind's declared configFields. */
export function buildInstanceConfigTemplate(configFields) {
  const config = {};
  for (const field of configFields ?? []) {
    config[field.key] = templateValueForField(field);
  }
  return config;
}

/** Human text for a failed `gate start`. The two common refusals — someone
 *  already listening on the port, or another Gate's instance lock — name what
 *  to check next instead of surfacing a bare errno string, because they fire
 *  exactly when the operator retries and nothing seems to be happening. */
export function describeStartFailure(error, port = 8760) {
  if (error?.code === 'EADDRINUSE') {
    return [
      `Error starting gate: something is already listening on port ${port} — likely a Versutus Gate that is still running.`,
      `Check whether it answers: curl http://127.0.0.1:${port}/.well-known/gateway.json — then use that Gate or stop it before starting again.`,
    ].join('\n');
  }
  if (typeof error?.message === 'string' && error.message.startsWith('Gate instance lock')) {
    return [
      `Error starting gate: ${error.message}`,
      `Verify the running one: http://127.0.0.1:${port}/.well-known/gateway.json`,
    ].join('\n');
  }
  return `Error starting gate: ${error?.message ?? String(error)}`;
}

/** Source text for a newly-scaffolded kind.mjs — the required fields
 *  as empty holes, matching how `add` scaffolds a provider config's holes. */
export function getKindTemplate(kindId, label, family) {
  return `export default {
  kind: ${JSON.stringify(kindId)},
  label: ${JSON.stringify(label)},
  family: ${JSON.stringify(family)},
  configFields: [
    // Describe this kind's config fields here, e.g.:
    // { key: 'example', label: 'Example', type: 'string', required: true },
  ],
  validate(config) {
    const errors = [];
    // Push { field, message } for each violated rule.
    return { ok: errors.length === 0, errors };
  },
  toManifestEntry(instance) {
    return {
      id: instance.id,
      // What does this kind advertise in the manifest?
    };
  },
  createHandlers(instance) {
    return {
      // RPC methods this instance answers, e.g.:
      // run: async () => ({ /* ... */ }),
    };
  },
};
`;
}
