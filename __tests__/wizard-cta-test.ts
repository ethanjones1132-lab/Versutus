import { deriveWizardCta } from '@/lib/onboarding/wizard-cta';

describe('deriveWizardCta', () => {
  test('background discovery searching never locks the manual Connect CTA', () => {
    // Matrix §G finding 2: probe rounds park the phase in 'searching' for
    // 30-60s; gating the CTA on that phase made the typed manual connect
    // unreachable for minutes on a machine where discovery only gets 403s.
    const state = deriveWizardCta(false, 'searching');
    expect(state.locked).toBe(false);
    expect(state.label).toBe('Connect gateway');
    // The theater should still animate so discovery looks alive.
    expect(state.theaterBusy).toBe(true);
  });

  test('the form own submit locks the CTA and shows Connecting…', () => {
    const state = deriveWizardCta(true, 'searching');
    expect(state.locked).toBe(true);
    expect(state.label).toBe('Connecting…');
    expect(state.theaterBusy).toBe(true);
  });

  test('a background connect attempt animates the theater but does not lock the form', () => {
    // The ambient 'connecting' phase can be the auto-connect ceremony, not
    // this form's submit — the typed form must stay actionable.
    const state = deriveWizardCta(false, 'connecting');
    expect(state.locked).toBe(false);
    expect(state.label).toBe('Connect gateway');
    expect(state.theaterBusy).toBe(true);
  });

  test('idle and failed phases are quiet and unlocked', () => {
    expect(deriveWizardCta(false, 'idle')).toEqual({
      locked: false,
      theaterBusy: false,
      label: 'Connect gateway',
    });
    expect(deriveWizardCta(false, 'failed')).toEqual({
      locked: false,
      theaterBusy: false,
      label: 'Connect gateway',
    });
  });

  test('connected makes the theater quiet and the CTA unlocked', () => {
    const state = deriveWizardCta(false, 'connected');
    expect(state.locked).toBe(false);
    expect(state.theaterBusy).toBe(false);
  });

  test('pairing and onboarding phases do not lock the manual CTA', () => {
    expect(deriveWizardCta(false, 'pairing').locked).toBe(false);
    expect(deriveWizardCta(false, 'onboarding').locked).toBe(false);
  });
});