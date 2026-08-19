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
 * Use this ONLY where the body is consumed as a stream. Ordinary requests have
 * no reason to route through a second implementation.
 */
let installed: typeof globalThis.fetch | null = null;

export function installStreamingFetch(impl: typeof globalThis.fetch): void {
  installed = impl;
}

export const streamingFetch: typeof globalThis.fetch = (input, init) =>
  (installed ?? globalThis.fetch)(input, init);
