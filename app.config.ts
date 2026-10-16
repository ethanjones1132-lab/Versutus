import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Personal gateway hosts — a Tailscale name, LAN IPs — must never be committed
 * to this public repo. `app.json` ships an empty `expo.extra.gatewayHosts`
 * list; a developer drops their own addresses in a gitignored
 * `gateway-hosts.local.json` (a JSON array of host strings) next to this file,
 * and this dynamic config merges them into the resolved app config.
 *
 * The committed config stays host-free, so `scripts/verify-config.mts` can
 * assert that no private or tailnet address ships.
 */
const LOCAL_HOSTS_FILE = 'gateway-hosts.local.json';

function readLocalGatewayHosts(): string[] {
  const path = join(__dirname, LOCAL_HOSTS_FILE);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (host): host is string => typeof host === 'string' && host.trim() !== '',
    );
  } catch {
    // A malformed local file is a developer mistake, not a build failure: an
    // empty fallback keeps the app buildable and the config host-free.
    return [];
  }
}

export default ({ config }: ConfigContext): Partial<ExpoConfig> => {
  const extra: Record<string, unknown> = { ...(config.extra ?? {}) };
  const committed = Array.isArray(extra.gatewayHosts)
    ? (extra.gatewayHosts as unknown[]).filter(
        (host): host is string => typeof host === 'string',
      )
    : [];

  return {
    ...config,
    extra: {
      ...extra,
      gatewayHosts: [...committed, ...readLocalGatewayHosts()],
    },
  };
};
