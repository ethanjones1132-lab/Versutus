export function validatePcAddress(value: string): { valid: boolean; message: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { valid: false, message: 'Enter your PC Tailscale name or 100.x.x.x address.' };
  }

  const hostnamePattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
  const tailnetIpPattern = /^100\.(?:\d{1,3}\.){2}\d{1,3}$/;

  if (hostnamePattern.test(trimmed) || tailnetIpPattern.test(trimmed)) {
    return { valid: true, message: 'Looks good — ready to connect.' };
  }

  return {
    valid: false,
    message: 'Use a Tailscale hostname (name.tailnet.ts.net) or tailnet IP (100.x.x.x).',
  };
}