const GATEWAY_TOKEN_REQUIRED_MARKERS = [
  'setup token required',
  'auth token missing',
  'auth token not configured',
  'token required',
];

export function isGatewayTokenRequiredMessage(message?: string | null): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return GATEWAY_TOKEN_REQUIRED_MARKERS.some((marker) => normalized.includes(marker));
}
