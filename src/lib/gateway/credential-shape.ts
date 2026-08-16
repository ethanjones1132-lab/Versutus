const CREDENTIAL_PREFIXES = ['sk-', 'sk_', 'gsk_', 'xai-', 'ghp_', 'github_pat_'];

/**
 * Mirrors the Gate's guard in `gate/core/capabilities/secrets.mjs`. The Gate is
 * the authority — this exists so the app can refuse before sending and explain
 * which field the value belongs in, rather than surfacing a round-trip error.
 *
 * A secret ref names a secret; it is not the secret. The vault writes each file
 * as `<ref>.dpapi`, so a key pasted into the ref field ends up as a filename.
 */
export function looksLikeCredential(refName: string | undefined | null): boolean {
  const value = String(refName ?? '').trim();
  if (!value) return false;
  const lowered = value.toLowerCase();
  if (CREDENTIAL_PREFIXES.some((prefix) => lowered.startsWith(prefix))) return true;
  // A real ref is a path or a phrase; an unbroken 32+ character run is a token.
  return value.length >= 32 && !/[/\-_.:]/.test(value);
}
