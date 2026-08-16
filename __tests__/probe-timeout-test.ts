import {
  GATEWAY_MANIFEST_PROBE_TIMEOUT_MS,
  GATEWAY_PROBE_PARALLEL_TIMEOUT_MS,
  GATEWAY_PROBE_TIMEOUT_MS,
} from '@/lib/gateway/probe';

describe('gateway probe budget', () => {
  // Phone → PC over Tailscale DERP was measured at 0.9–1.7s RTT with
  // dropped pings. A 3–3.5s /health probe aborts while the TCP handshake
  // is still in SynReceived; the socket later shows up as TIME_WAIT.
  test('onboarding probe waits long enough for a lossy Tailscale relay hop', () => {
    expect(GATEWAY_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(12_000);
    expect(GATEWAY_PROBE_PARALLEL_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(GATEWAY_MANIFEST_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(8_000);
  });
});
