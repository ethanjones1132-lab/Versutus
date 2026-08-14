export function assertSafeAuthorizationUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('authorization URL is not valid HTTPS');
  }
  if (url.protocol !== 'https:') {
    throw new Error('authorization URL must be https');
  }
  return url.toString();
}

export async function openAuthorizationUrl(value, { opener } = {}) {
  const safe = assertSafeAuthorizationUrl(value);
  if (opener) return opener(safe);
  return safe;
}
