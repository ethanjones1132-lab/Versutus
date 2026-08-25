import type { ConnectionPhase } from '@/context/gateway-provider';

/**
 * The first-run wizard's Connect CTA must never be held hostage by the
 * background auto-connect ceremony. Discovery probe rounds park the phase in
 * 'searching' for 30–60 s at a time (and the retry ladder re-fires them), so
 * a CTA gated on the ambient phase is disabled for minutes on a machine where
 * discovery only ever gets 403s — the operator's typed manual connect becomes
 * unreachable exactly when they need it most (matrix §G finding 2, fixed).
 *
 * The theater (scan strip, timeline, probe message) keeps animating for any
 * probe or connect in flight; only the form's own submit (`working`) locks
 * the CTA, matching `/gateway/add`'s `saving` gate.
 */
export type WizardCtaState = {
  /** CTA disabled + label "Connecting…" — true only while this form's submit is in flight. */
  locked: boolean;
  /** Scan strip / timeline / probe-message theater should animate. */
  theaterBusy: boolean;
  label: 'Connecting…' | 'Connect gateway';
};

export function deriveWizardCta(working: boolean, connectionPhase: ConnectionPhase): WizardCtaState {
  const searching = connectionPhase === 'searching';
  const connecting = connectionPhase === 'connecting';
  return {
    locked: working,
    theaterBusy: working || connecting || searching,
    label: working ? 'Connecting…' : 'Connect gateway',
  };
}