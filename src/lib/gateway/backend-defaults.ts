// ─── Which chat backend a fresh connection should land on ─────────────
//
// `selectedBackendId` used to start as `undefined` and stay there until the
// operator opened Gate setup and tapped a chip. Nothing said so: the setup
// screen rendered `selectedBackendId ?? backends[0]?.id` as the selected chip,
// so a backend LOOKED chosen while the provider still held undefined — and
// `backends[0]` is `claude-local`, not the Hermes environment every Bot,
// cron and group room on this Gate actually lives in.
//
// So every cold start began with the same ritual: settings → pick Hermes →
// start the CLI → back to chat. This resolves it up front instead.

import type { GatewayBackend } from '@/lib/portal/manifest';

/**
 * Capabilities the app's core surfaces need, richest first.
 *
 * Deliberately a capability ranking rather than a hard-coded `hermes` check:
 * Bots, crons and group rooms are all Hermes concepts today, so the backend
 * declaring `bots` IS the Hermes one — but if a different bot-capable
 * environment is ever attached, it should win the same way rather than being
 * passed over for a vendor string. `chat` is the floor; a backend that cannot
 * hold a conversation is never a chat default however much else it offers.
 */
const CORE_CAPABILITIES = ['bots', 'sessions', 'models', 'tools'] as const;

/** How well a backend serves the app, higher is better. -1 means "never". */
export function backendScore(backend: GatewayBackend): number {
  const capabilities = new Set(backend.capabilities ?? []);
  // Without chat there is no conversation to default to, whatever else it does.
  if (!capabilities.has('chat')) return -1;
  return CORE_CAPABILITIES.reduce((score, name) => score + (capabilities.has(name) ? 1 : 0), 1);
}

/**
 * The backend a connection should use, given what the Gate advertises and
 * whatever the operator last chose on this gateway.
 *
 * A remembered choice always wins while it still exists — switching backend is
 * an explicit act and must survive a reconnect. It is ignored only when the
 * Gate no longer advertises it, which is the one case where honouring it would
 * strand the operator on a backend that cannot answer.
 *
 * Returns undefined only when there is genuinely nothing to pick, so callers
 * can tell "no backends yet" from "resolved to the first one".
 */
export function resolveDefaultBackend(
  backends: GatewayBackend[] | undefined,
  remembered?: string,
): string | undefined {
  const available = backends ?? [];
  if (available.length === 0) return undefined;

  if (remembered && available.some((backend) => backend.id === remembered)) return remembered;

  let best: GatewayBackend | undefined;
  let bestScore = 0;
  for (const backend of available) {
    const score = backendScore(backend);
    // Strictly greater keeps declaration order as the tie-break, so an equally
    // capable pair resolves the same way on every launch instead of flapping.
    if (score > bestScore) {
      best = backend;
      bestScore = score;
    }
  }

  // Every backend scored -1 (none can chat). Falling back to the first is
  // still better than leaving the app with no backend at all: the operator
  // sees a real selection to correct rather than an empty picker.
  return best?.id ?? available[0]?.id;
}
