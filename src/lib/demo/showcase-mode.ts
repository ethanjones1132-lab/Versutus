import { Platform } from 'react-native';

const SHOWCASE_KEY = 'versutus:showcase';

/**
 * The showcase fleet: a fixed Gate, Bots and transcripts the real screens can
 * render with no live connection. Dev builds on the web only — the flag is
 * read from `?showcase=1` (kept in localStorage so in-app navigation stays in
 * it) and cleared by `?showcase=0`. A release build, or any native build,
 * answers false before it reads anything.
 */
export function isShowcaseMode(): boolean {
  if (!__DEV__ || Platform.OS !== 'web' || typeof window === 'undefined') return false;
  try {
    const flag = new URLSearchParams(window.location.search).get('showcase');
    if (flag === '1') window.localStorage.setItem(SHOWCASE_KEY, '1');
    if (flag === '0') window.localStorage.removeItem(SHOWCASE_KEY);
    return window.localStorage.getItem(SHOWCASE_KEY) === '1';
  } catch {
    return false;
  }
}
