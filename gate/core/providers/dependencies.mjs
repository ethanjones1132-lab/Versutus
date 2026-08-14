export function dependentsOf(providerId, agents = []) {
  return agents
    .filter((agent) => Array.isArray(agent.dependencies) && agent.dependencies.some((dependency) => dependency.providerId === providerId))
    .map((agent) => agent.id);
}

export function assertProviderDeletionAllowed(providerId, agents = [], { resolve = [] } = {}) {
  const dependents = dependentsOf(providerId, agents);
  const resolved = new Set(resolve);
  const blocking = dependents.filter((id) => !resolved.has(id));
  if (blocking.length > 0) {
    const error = new Error(`provider "${providerId}" has dependents: ${blocking.join(', ')}`);
    error.code = 'provider_has_dependents';
    error.dependents = blocking;
    throw error;
  }
  return { ok: true, dependents };
}
