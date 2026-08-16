export async function revokeToken({ revocationEndpoint, token, fetchImpl = fetch }) {
  if (!revocationEndpoint || !token) return { remote: false };
  try {
    const response = await fetchImpl(revocationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    return { remote: response.ok };
  } catch {
    return { remote: false };
  }
}
