/**
 * `fetch` for responses the app reads incrementally.
 *
 * React Native's global fetch is `whatwg-fetch` over XMLHttpRequest — RN 0.86
 * still ships it, `Libraries/Network/fetch.js` being a bare re-export. Its
 * Response has no `body` property at all; the prototype is `bodyUsed,
 * _initBody, arrayBuffer, text, formData, json, clone`. So
 * `response.body?.getReader()` is `undefined` and every SSE reader throws
 * "No response body to stream" on device, however correctly the server streams.
 * Token-by-token chat and the Shell tab could not work through it, ever.
 *
 * `expo/fetch` is WinterCG-compliant and does expose a readable body, which is
 * what `streamSSE` already expects.
 *
 * It is installed rather than imported here on purpose. `expo/fetch` resolves
 * to a native-backed function under jest-expo too, where it cannot work, so
 * importing it directly would break every test that drives streaming through a
 * mocked global fetch. The app installs the real one at startup; Node and web,
 * whose global fetch already streams, keep it.
 *
 * The un-installed fallback is therefore capability-checked, not blind. Before
 * installation this module asks whether the global `Response` actually exposes
 * a readable body: undici (Node ≥18) and browsers define a `body` getter on
 * the prototype, whatwg-fetch does not. Falling back blindly is how the
 * fb46406 bug class stayed invisible — a body-less Response handed to SSE
 * readers yields a silently empty stream on device while every Node test stays
 * green, because Node's global streams fine. That case now refuses loudly with
 * the fix named instead of returning something that cannot work.
 *
 * Use this ONLY where the body is consumed as a stream. Ordinary requests have
 * no reason to route through a second implementation.
 */

let installed: typeof globalThis.fetch | null = null;

export function installStreamingFetch(impl: typeof globalThis.fetch): void {
  installed = impl;
}

/**
 * Test/harness escape hatch back to the pristine, nothing-installed state, so
 * suites can exercise both sides of the installation seam deterministically.
 */
export function resetStreamingFetchForTests(): void {
  installed = null;
}

/**
 * True when the global fetch's Response actually exposes a readable body.
 * Checked per call rather than cached: it is a couple of property reads next
 * to a network request, and caching would bind the answer to whichever
 * environment happened to import or run first.
 */
function globalFetchStreams(): boolean {
  if (typeof globalThis.Response !== 'function') return false;
  const proto = (globalThis.Response as unknown as { prototype?: unknown }).prototype;
  return typeof proto === 'object' && proto !== null && 'body' in proto;
}

export const streamingFetch: typeof globalThis.fetch = (input, init) => {
  if (installed) return installed(input, init);
  // Node and web never install: their global fetch already streams, so riding
  // it is correct there, not a fallback gone wrong.
  if (globalFetchStreams()) return globalThis.fetch(input, init);
  // A global whose Response has no body means RN device. Returning from here
  // used to hand SSE readers a body-less Response — empty bubbles on device
  // with nothing to explain them, while Node tests stayed green. Fail where
  // the mistake actually is.
  throw new Error(
    'streamingFetch ran before installStreamingFetch() on a platform whose global fetch ' +
      'has no readable response body, so streamed replies would arrive empty. Call ' +
      'installStreamingFetch(expoFetch) once at app startup before any streaming call site ' +
      'runs — src/app/_layout.tsx does this for the Expo app.',
  );
};
