import { fetch as expoFetch } from 'expo/fetch';

/**
 * `fetch` for responses the app reads incrementally.
 *
 * React Native's global fetch is `whatwg-fetch` over XMLHttpRequest (RN 0.86
 * still ships it: Libraries/Network/fetch.js is a bare re-export). Its Response
 * has no `body` property at all — the prototype is `bodyUsed, _initBody,
 * arrayBuffer, text, formData, json, clone`. So `response.body?.getReader()` is
 * `undefined` and every SSE reader throws "No response body to stream" on
 * device, no matter how correctly the server streams. Token-by-token chat and
 * the Shell tab could not work through it, ever.
 *
 * `expo/fetch` is a WinterCG-compliant implementation that does expose a
 * readable body, which is exactly what `streamSSE` already expects.
 *
 * Use this ONLY where the body is consumed as a stream. Ordinary requests
 * should keep using global fetch — there is no reason to route them through a
 * second implementation.
 */
export const streamingFetch = (
  typeof expoFetch === 'function' ? expoFetch : globalThis.fetch
) as unknown as typeof globalThis.fetch;
