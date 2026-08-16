const DEFAULT_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export async function discoverIssuer(issuerUrl, { allowedHosts, fetchImpl = fetch } = {}) {
  const issuer = new URL(issuerUrl);
  const allowed = new Set(allowedHosts ?? DEFAULT_HOSTS);
  if (!allowed.has(issuer.hostname)) {
    throw new Error(`issuer host ${issuer.hostname} is not pinned`);
  }

  const wellKnown = new URL('/.well-known/oauth-authorization-server', issuer);
  const response = await fetchImpl(wellKnown);
  if (!response.ok) throw new Error(`issuer discovery failed: ${response.status}`);
  const metadata = await response.json();

  for (const key of ['token_endpoint', 'authorization_endpoint', 'device_authorization_endpoint', 'revocation_endpoint']) {
    if (!metadata[key]) continue;
    const endpoint = new URL(metadata[key]);
    if (endpoint.hostname !== issuer.hostname) {
      throw new Error(`${key} left the pinned issuer host`);
    }
  }
  return metadata;
}
