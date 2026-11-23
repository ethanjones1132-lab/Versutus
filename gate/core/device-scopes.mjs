/**
 * What this Gate itself knows a device grant may name.
 *
 * The authority is `gate/core/server.mjs`: the `scope` values of
 * `DEVICE_ACT_SCOPES` and `DEVICE_RPC_SCOPES` (the route and RPC tables around
 * lines 809-893) decide which request a grant can make, and the `action` text
 * beside them is the plain-words label copied below. The two read-only scopes,
 * `chat:read` and `runs:read`, are not in those tables because reads stay
 * caller-scoped; they are listed here so a read scope is not trimmed away.
 *
 * This is a copy of names and labels, never a second authority: a new acting
 * route or RPC method becomes real by joining those tables, and this list has
 * to follow it. Nothing here widens what the Gate lets a device do — it only
 * decides which requested names may be written into a grant.
 */
export const KNOWN_ROLES = Object.freeze(['operator']);

export const DEVICE_SCOPES = Object.freeze([
  { scope: 'terminal:use', action: 'open a shell' },
  { scope: 'chat:send', action: 'send a chat turn' },
  { scope: 'runs:start', action: 'start a run' },
  { scope: 'sessions:manage', action: 'create a session' },
  { scope: 'bots:manage', action: 'create a Bot' },
  { scope: 'routines:manage', action: 'create a routine' },
  { scope: 'providers:manage', action: 'register a provider' },
  { scope: 'environments:manage', action: 'add an environment' },
  { scope: 'capabilities:manage', action: 'add a capability' },
  { scope: 'devices:manage', action: 'revoke a paired device' },
  { scope: 'voice:manage', action: 'start a voice call' },
  // Reads: a grant names the read it allows, and no table above carries a verb
  // for it, so the scope's own name is its label.
  { scope: 'chat:read', action: null },
  { scope: 'runs:read', action: null },
]);

const SCOPE_ACTIONS = new Map(DEVICE_SCOPES.map(({ scope, action }) => [scope, action]));

export function isKnownRole(role) {
  return typeof role === 'string' && KNOWN_ROLES.includes(role);
}

export function isKnownScope(scope) {
  return typeof scope === 'string' && SCOPE_ACTIONS.has(scope);
}

/** The plain-words label a table gives a scope, or the scope's own name. */
export function scopeLabel(scope) {
  return SCOPE_ACTIONS.get(scope) ?? scope;
}

/**
 * Restrict a requested grant to the names this Gate knows.
 *
 * `null` means the role itself is unknown and the grant must be refused: a
 * grant is issued for a role the Gate understands, never for a word a phone
 * chose. A scope the Gate does not know is dropped, not an error — the
 * request still becomes a pending grant, and if it asked for nothing it
 * becomes a grant of nothing. Known scopes keep the order they were asked in
 * and duplicates collapse to the first mention; `dropped` lists what was
 * removed, so the operator page can say the request was trimmed.
 */
export function clampGrant({ role, scopes } = {}) {
  if (!isKnownRole(role)) return null;
  const requested = Array.isArray(scopes) ? scopes : [];
  const kept = [];
  const dropped = [];
  for (const scope of requested) {
    if (!isKnownScope(scope)) {
      dropped.push(scope);
      continue;
    }
    if (!kept.includes(scope)) kept.push(scope);
  }
  return { role, scopes: kept, dropped };
}
