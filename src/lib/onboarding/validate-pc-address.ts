export function validatePcAddress(value: string): { valid: boolean; message: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { valid: false, message: 'Enter your PC Tailscale name or 100.x.x.x address.' };
  }

  // Optional :port so Gate (:8760) can be named explicitly; Hermes defaults to :8642.
  const withoutPort = trimmed.replace(/:(\d{2,5})$/, '');
  const hostnamePattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
  const tailnetIpPattern = /^100\.(?:\d{1,3}\.){2}\d{1,3}$/;
  const lanIpPattern = /^(?:\d{1,3}\.){3}\d{1,3}$/;

  if (
    hostnamePattern.test(withoutPort) ||
    tailnetIpPattern.test(withoutPort) ||
    lanIpPattern.test(withoutPort)
  ) {
    return { valid: true, message: 'Looks good — ready to connect.' };
  }

  return {
    valid: false,
    message: 'Use a Tailscale hostname, tailnet IP (100.x.x.x), or LAN IP — optional :port (Gate is 8760).',
  };
}