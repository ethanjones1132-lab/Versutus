/**
 * Sentence case for a short label: "HANDS-FREE CALL" → "Hands-free call".
 *
 * Sheet eyebrows are authored in capitals across the app; the Nocturne sheet
 * sets them quietly in sentence case instead. Only a label that arrives
 * entirely upper-case is recased, so a caller that already wrote "Bot" or
 * named an acronym inside mixed case keeps exactly what it wrote.
 */
export function sentenceCase(label: string): string {
  const trimmed = label.trim();
  if (!trimmed || trimmed !== trimmed.toUpperCase()) return trimmed;
  const lower = trimmed.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
