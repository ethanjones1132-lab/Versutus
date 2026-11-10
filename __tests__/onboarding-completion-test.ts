import { onboardingCompletionForAddedGateway } from '@/lib/onboarding/completion-from-add';

describe('onboarding completion from an added gateway', () => {
  test('a tailnet URL derives the host for future auto-connect probing', () => {
    expect(onboardingCompletionForAddedGateway('https://my-pc.example.ts.net', {})).toEqual({
      onboardingComplete: true,
      tailscaleHost: 'my-pc.example.ts.net',
      pcName: 'My-pc',
    });
  });

  test('scheme, port, and path never leak into the saved host', () => {
    expect(onboardingCompletionForAddedGateway('http://MyPC.example.ts.net:8760/gate', {})).toEqual({
      onboardingComplete: true,
      tailscaleHost: 'mypc.example.ts.net',
      pcName: 'Mypc',
    });
  });

  test('an IP add completes onboarding without titling the app after a number', () => {
    expect(onboardingCompletionForAddedGateway('ws://192.168.1.30:7400/openclaw', {})).toEqual({
      onboardingComplete: true,
      tailscaleHost: '192.168.1.30',
    });
  });

  test('the first deliberately added machine wins; later adds never churn it', () => {
    expect(
      onboardingCompletionForAddedGateway('https://other.tailnet.ts.net', {
        tailscaleHost: 'my-pc.example.ts.net',
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
