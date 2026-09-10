// ─── The device side of a shared text ─────────────────────────────────────
// The one file that names `expo-share-intent`, kept off the rules in
// `share-intent.ts` the way `speech-recognition-native.ts` is kept off
// `speech-recognition.ts`.
//
// The package reads its native module with `requireOptionalNativeModule`, so a
// build with no native side — Expo Go, and every client built before the config
// plugin ran a prebuild — answers null where the module would be, while the
// import itself still runs package code that reaches for `expo-constants` and
// `expo-linking`. The package is therefore imported on the seam's first call
// rather than at boot: a load that fails is no share-intent support at all,
// never a rejection into the router, and that is the whole reason this module
// exists apart from the seam.

/**
 * The package once it is loaded: the native module (or null where the build
 * carries none) plus the helpers the seam reads a payload and a storage key
 * with. The shape is read off the import rather than restated, so an upgrade
 * that moves an export fails the typecheck instead of the router.
 */
export type ShareIntentPackage = typeof import('expo-share-intent');

/**
 * The share-intent package this build carries, or null when it carries none.
 * A load that throws is the same answer as a load that finds nothing: the
 * platform's shares go unread rather than read into a throw.
 */
export async function loadShareIntentPackage(): Promise<ShareIntentPackage | null> {
  try {
    return await import('expo-share-intent');
  } catch {
    return null;
  }
}
