import { onboardingCompletionForAddedGateway } from '@/lib/onboarding/completion-from-add';

describe('onboarding completion from an added gateway', () => {
  test('a tailnet URL derives the host for future auto-connect probing', () => {
    expect(onboardingCompletionForAddedGateway('https://ethanspc.tail3a1a8a.ts.net', {})).toEqual({
      onboardingComplete: true,
      tailscaleHost: 'ethanspc.tail3a1a8a.ts.net',
      pcName: 'Ethanspc',
    });
  });

  test('scheme, port, and path never leak into the saved host', () => {
    expect(onboardingCompletionForAddedGateway('http://EthanPC.tail3a1a8a.ts.net:8760/gate', {})).toEqual({
      onboardingComplete: true,
      tailscaleHost: 'ethanpc.tail3a1a8a.ts.net',
      pcName: 'Ethanpc',
    });
  });

  test('an IP add completes onboarding without titling the app after a number', () => {
    expect(onboardingCompletionForAddedGateway('ws://192.168.4.30:7400/openclaw', {})).toEqual({
      onboardingComplete: true,
      tailscaleHost: '192.168.4.30',
    });
  });

  test('the first deliberately added machine wins; later adds never churn it', () => {
    expect(
      onboardingCompletionForAddedGateway('https://other.tailnet.ts.net', {
        tailscaleHost: 'ethanspc.tail3a1a8a.ts.net',
      }),
    ).toEqual({ onboardingComplete: true });
  });

  test('unparseable URLs still complete onboarding', () => {
    expect(onboardingCompletionForAddedGateway('', {})).toEqual({ onboardingComplete: true });
    expect(onboardingCompletionForAddedGateway('definitely not a url', {})).toEqual({ onboardingComplete: true });
  });

  test('dot-less hosts stay out of the probe-target slot', () => {
    expect(onboardingCompletionForAddedGateway('http://localhost:8642', {})).toEqual({ onboardingComplete: true });
  });
});
