/**
 * Candidate plumbing for the cold-start auto-connect race.
 *
 * `runAutoConnect` used to await the full discovery window before probing
 * anything. The synchronously-known high-priority URLs (web loopbacks plus
 * the gateway that answered last run) are probed immediately while the
 * discovery window runs; the discovered beacons are merged when it lands.
 * These helpers keep that ordering in one tested place.
 */

import { HIGH_PRIORITY_WAVE_SIZE } from '@/lib/gateway/probe';

/** URLs known without waiting for discovery: web loopbacks + last success. */
export function buildEarlyProbeUrls(options: {
  platform: string;
  lastSuccessfulUrl?: string | null;
}): string[] {
  const urls: string[] = [];
  if (options.platform === 'web') {
    for (const localUrl of ['http://127.0.0.1:8642', 'http://localhost:8642']) {
      if (!urls.includes(localUrl)) urls.push(localUrl);
    }
  }
  const lastUrl = options.lastSuccessfulUrl;
  if (lastUrl && !urls.includes(lastUrl)) urls.push(lastUrl);
  return urls;
}

/**
 * Merge discovered beacons behind the already-probed early URLs, preserving
 * the established order (known first, fresh beacons after, no duplicates).
 */
export function mergeDiscoveredProbeUrls(
  earlyUrls: string[],
  discovered: { url: string }[],
): string[] {
  const merged = [...earlyUrls];
  for (const beacon of discovered) {
    if (!merged.includes(beacon.url)) merged.push(beacon.url);
  }
  return merged;
}

/**
 * Trailing-slash-insensitive URL comparison, matching how `probeGatewayUrl`
 * normalizes a probed URL before reporting it. Used to recognise that an
 * early-wave success already proved the saved gateway URL, so the saved
 * path does not probe the same live gateway twice.
 */
export function sameGatewayUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/**
 * Drop the fallback candidates the probe waves already tried and missed.
 *
 * Each `probeHighPriorityCandidates` wave probes only the head of its list
 * (`HIGH_PRIORITY_WAVE_SIZE`), so only those heads are dropped — beacons
 * past the head were never probed and always survive. Order is preserved so
 * earliest-healthy-wins is unchanged. Comparison errs toward keeping: a URL
 * that fails to match is probed again (the old behaviour), never skipped.
 */
export function dropAlreadyWavedCandidates(
  candidates: string[],
  earlyUrls: string[],
  highPriorityUrls: string[],
): string[] {
  const waved = new Set<string>();
  for (const url of earlyUrls.slice(0, HIGH_PRIORITY_WAVE_SIZE)) {
    waved.add(url.replace(/\/+$/, ''));
  }
  for (const url of highPriorityUrls.slice(0, HIGH_PRIORITY_WAVE_SIZE)) {
    waved.add(url.replace(/\/+$/, ''));
  }
  return candidates.filter((candidate) => !waved.has(candidate.replace(/\/+$/, '')));
}
