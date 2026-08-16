/**
 * @param {Object} deps
 * @param {() => Promise<unknown>} [deps.onChanged] - refresh derived state (the
 *   manifest advertises backends, so registering an environment must update it;
 *   otherwise a newly attached CLI stays invisible until the Gate restarts).
 */
export function createEnvironmentRpc({ store, service, registry, onChanged }) {
  const changed = async (result) => {
    await onChanged?.().catch(() => undefined);
    return result;
  };

  return {
    /**
     * The CLI adapters this Gate ships, so a client can offer a picker instead
     * of the operator guessing an adapterId the schema will silently reject.
     */
    'environments.adapters.list': async () => ({
      adapters: registry.list().map((adapter) => ({
        adapterId: adapter.adapterId,
        adapterRevision: adapter.adapterRevision,
        supportedCliVersions: adapter.supportedCliVersions,
        protocols: Object.keys(adapter.protocolVersions ?? {}),
        capabilities: adapter.capabilities ?? [],
        operations: Object.keys(adapter.operations ?? {}),
      })),
    }),
    'environments.list': async () => {
      const records = await store.list();
      return {
        environments: records.map((record) => sanitizeEnvironment(
          record,
          service.environmentState.get(record.id),
        )),
      };
    },
    'environments.create': async (input = {}) => {
      await store.put(input);
      return changed({ ok: true, id: input.id });
    },
    'environments.update': async ({ id, ...input } = {}) => {
      const existing = await store.get(id);
      if (!existing) throw new Error(`environment "${id}" not found`);
      await store.put({ ...existing, ...input, id });
      return changed({ ok: true });
    },
    'environments.delete': async ({ id } = {}) => {
      await store.delete(id);
      return changed({ ok: true });
    },
    'environments.check': async ({ id } = {}) => service.check(id),
    'environments.commands.list': async ({ id } = {}) => {
      const record = await store.get(id);
      if (!record) throw new Error(`environment "${id}" not found`);
      return registry.get(record.adapterId).operations;
    },
    'environments.lifecycle.start': async ({ id } = {}) => service.start(id),
    'environments.lifecycle.stop': async ({ id } = {}) => service.stop(id),
  };
}

export function sanitizeEnvironment(record, status = {}) {
  return {
    id: record.id,
    label: record.label,
    adapterId: record.adapterId,
    enabled: record.enabled,
    providerRefs: record.providerRefs,
    workspacePolicy: record.workspacePolicy,
    lifecycle: record.lifecycle,
    protocolPreference: record.protocolPreference,
    versionPolicy: record.versionPolicy,
    executable: { path: record.executable.path },
    state: status.state ?? (record.enabled ? 'stopped' : 'disabled'),
    probe: status.probe,
  };
}
