/**
 * The live RPC dispatch table the snapshot block judges every slash command
 * by. A Gate reports its own table (`rpcMethods` on the capabilities read);
 * Hermes reports none, which means "unknown", never "none".
 *
 * This module holds the pure decisions so the Gateway screen section stays a
 * thin reader: normalize the already-held array, pick the honest copy for
 * each state, and label the collapsed toggle.
 */

/**
 * Normalize an unknown `rpcMethods` value. An absent or malformed value
 * stays `undefined` ("unknown", never "none"); a well-formed array keeps
 * its non-empty string entries, deduplicated and sorted for a stable read.
 */
export function normalizeRpcMethods(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (!name) continue;
    seen.add(name);
  }
  return [...seen].sort();
}

/**
 * Honest copy for the section body. `undefined` is the unknown note (the
 * gateway cannot tell us), never an empty table. An empty list is a real
 * "none" answer; a populated list renders rows and needs no copy.
 */
export function rpcMethodsListCopy(methods: string[] | undefined): string | undefined {
  if (methods === undefined) return 'This gateway does not report which RPC methods it answers.';
  if (methods.length === 0) return 'No RPC methods reported.';
  return undefined;
}

/** Collapsed-by-default toggle label. Count only when the list is known. */
export function rpcMethodsToggleLabel(open: boolean, count: number | undefined): string {
  if (open) return 'Hide methods';
  if (count === undefined) return 'Answered RPC methods';
  return `Answered RPC methods (${count})`;
}

/** Minimal shape consulted for the slash subtitle. Both the dashboard
 * registry (`GatewayCommand`) and the manifest dynamic commands
 * (`GatewayCapabilityCommand`) carry it. */
export type RpcSlashEntry = {
  method?: string;
  slash?: string;
};

/**
 * First slash wins per method, from the already-held registry entries.
 * Entries with no method or no slash are skipped; nothing is guessed, so
 * a method the registry does not know stays absent and renders bare.
 */
export function buildRpcMethodSlashMap(commands: RpcSlashEntry[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const command of commands) {
    const method = command.method;
    const slash = command.slash;
    if (typeof method !== 'string' || !method.trim()) continue;
    if (typeof slash !== 'string' || !slash.trim()) continue;
    if (map[method] !== undefined) continue;
    map[method] = slash;
  }
  return map;
}

/** The slash that speaks a method, where the registry knows one. */
export function rpcMethodSlash(
  method: string,
  map: Record<string, string>,
): string | undefined {
  if (!method.trim()) return undefined;
  return map[method];
}
