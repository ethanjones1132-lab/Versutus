// ─── The device side of a hands-free call ─────────────────────────────────
// The one file that names the local native module, kept off the call provider
// the way `speech-device.ts` is kept off `speech.ts`.
//
// The module's own entry loads its native implementation the instant it is
// imported (`requireNativeModule('HandsfreeVoice')`), which THROWS where there
// is no native side — Expo Go, the web bundle, and any client built before the
// module was autolinked. A static import would therefore take the app down at
// boot rather than let the Call control ask whether it can be offered, so the
// module is imported on the first call instead. A load that fails is no call
// capability at all, never a rejection into the screen; that is why the
// provider's calls are async.

/**
 * The native call module this build carries. The entry's default export is the
 * `NativeModule` instance, so its shape is read off the export itself.
 */
export type HandsfreeNativeModule = typeof import('../../../modules/handsfree-voice').default;

/**
 * The call module this build carries, or null when it carries none. A load
 * that throws is the same answer as a load that finds nothing: the operator is
 * offered no Call control rather than one whose tap could only fail.
 */
export async function loadHandsfreeModule(): Promise<HandsfreeNativeModule | null> {
  try {
    const module = await import('../../../modules/handsfree-voice');
    return module.default;
  } catch {
    return null;
  }
}
