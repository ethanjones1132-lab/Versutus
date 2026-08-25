/**
 * The token a connect should use: a freshly granted pairing token wins over
 * the stale state value captured in the caller's closure.
 *
 * Regression: the add-gateway screen set granted tokens into React state and
 * then saved the profile with the closure's pre-update value, so a successful
 * auto-grant (pair-open window) was silently dropped, the connect retried
 * without a token, and the app told the operator to paste the setup token
 * manually — the pairing story never connected (verified 2026-08-24 against
 * a live demo Gate: the Gate issued the token, the app threw it away).
 */
export function connectToken(granted: string | undefined, entered: string | undefined): string | undefined {
  const clean = (value?: string) => (value ?? '').trim();
  const grantedClean = clean(granted);
  const enteredClean = clean(entered);
  if (grantedClean) return grantedClean;
  if (enteredClean) return enteredClean;
  return undefined;
}