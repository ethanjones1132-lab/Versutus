import { isCanonicalIpv4 } from '@/lib/gateway/url';

export function validatePcAddress(value: string): { valid: boolean; message: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { valid: false, message: 'Enter your PC Tailscale name or 100.x.x.x address.' };
  }

  // Optional :port so Gate (:8760) can be named explicitly; Hermes defaults to :8642.
  // The RANGE is checked here, not just the shape: `new URL` refuses any port
  // above 65535, so `host:99999` used to read "ready", be saved as
  // `tailscaleHost`, and then be dropped from every candidate wave by the
  // parser's throw — an address this device could never reach and never learn
  // it could not. Rejecting it up front is the only point that still has the
  // operator's attention.
  const portMatch = /:(\d+)$/.exec(trimmed);
  if (portMatch) {
    const port = Number(portMatch[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { valid: false, message: 'Ports go from 1 to 65535.' };
    }
  }
  const withoutPort = portMatch ? trimmed.slice(0, -(portMatch[1].length + 1)) : trimmed;
  const hostnamePattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
  const tailnetIpPattern = /^100\.(?:\d{1,3}\.){2}\d{1,3}$/;
  const lanIpPattern = /^(?:\d{1,3}\.){3}\d{1,3}$/;

  // Dotted-decimal first, and only then the hostname fallback. `hostnamePattern`
  // also matches an all-numeric string like 999.999.999.999, so testing it first
  // would wave through the very address the octet check exists to reject. And the
  // octet check must NOT apply to hostnames: `studio.tailnet.ts.net` splits to
  // four NaNs and would be refused, which is the address onboarding asks for.
  // The canonical-quad rule is the one normalizeGatewayUrl enforces too, so a
  // dotted-decimal the parser would reinterpret (0250.168.0.1, 1.2.3) is refused
  // here instead of waved through to save or probe some other address.
  if (tailnetIpPattern.test(withoutPort) || lanIpPattern.test(withoutPort)) {
    if (!isCanonicalIpv4(withoutPort)) {
      return { valid: false, message: 'Use a Tailscale hostname, tailnet IP (100.x.x.x), or LAN IP — optional :port (Gate is 8760).' };
    }
    return { valid: true, message: 'Looks good — ready to connect.' };
  }

  if (hostnamePattern.test(withoutPort)) {
    return { valid: true, message: 'Looks good — ready to connect.' };
  }

  return {
    valid: false,
    message: 'Use a Tailscale hostname, tailnet IP (100.x.x.x), or LAN IP — optional :port (Gate is 8760).',
  };
}
