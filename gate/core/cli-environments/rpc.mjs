export function createEnvironmentRpc({ store, service, registry }) {
  return {
    'environments.create': async (input = {}) => {
      await store.put(input);
      return { ok: true, id: input.id };
    },
    'environments.update': async ({ id, ...input } = {}) => {
      const existing = await store.get(id);
      if (!existing) throw new Error(`environment "${id}" not found`);
      await store.put({ ...existing, ...input, id });
      return { ok: true };
    },
    'environments.delete': async ({ id } = {}) => {
      await store.delete(id);
      return { ok: true };
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
