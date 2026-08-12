/**
 * Builds the Gate's per-instance RPC dispatch table: each instance's
 * createHandlers() output, keyed by "<instance-id>.<localName>". Because
 * gate/registry/<id>.json is a flat, globally-unique namespace, this makes
 * cross-instance collision structurally impossible — a kind author never
 * has to coordinate method names with other instances, even of their own
 * kind.
 *
 * @param {Map<string, object>} kinds
 * @param {Array<{id, kind, label, config}>} instances
 * @returns {Map<string, (params: unknown) => unknown>}
 */
export function buildInstanceHandlers(kinds, instances) {
  const table = new Map();
  for (const instance of instances) {
    const kindModule = kinds.get(instance.kind);
    let handlers;
    try {
      handlers = kindModule.createHandlers(instance);
    } catch (err) {
      console.error(`buildInstanceHandlers: createHandlers() threw for instance "${instance.id}": ${err.message}`);
      continue;
    }
    for (const [localName, handlerFn] of Object.entries(handlers ?? {})) {
      table.set(`${instance.id}.${localName}`, handlerFn);
    }
  }
  return table;
}
