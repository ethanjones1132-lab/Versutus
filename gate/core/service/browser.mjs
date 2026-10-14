// Loopback issuers stay on http in this Gate's own dev model (see the pinned
// hosts in gate/core/providers/oauth/discovery.mjs), and cleartext there never
// leaves the device, so it is not refused. The phone decides separately what
// it will open (isSafeAuthorizationUrl in src/lib/gateway/provider-oauth.ts).
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function assertSafeAuthorizationUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('authorization URL is not valid HTTPS');
  }
  if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('authorization URL must be https');
  }
  return url.toString();
}
