export async function startDeviceAuthorization({ deviceAuthorizationEndpoint, clientId, fetchImpl = fetch }) {
  const response = await fetchImpl(deviceAuthorizationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: 'openid' }),
  });
  if (!response.ok) throw new Error(`device authorization failed: ${response.status}`);
  return response.json();
}

export async function pollDeviceToken({ tokenEndpoint, clientId, deviceCode, fetchImpl = fetch }) {
  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: clientId,
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || 'device token failed');
    error.code = payload.error;
    throw error;
  }
  return payload;
}
