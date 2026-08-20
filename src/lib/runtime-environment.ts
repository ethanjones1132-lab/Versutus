import { streamingFetch } from '@/lib/net/streaming-fetch';

/**
 * What this build's JavaScript engine actually provides.
 *
 * Every test in this repo runs in Node, where the Web APIs the app uses all
 * exist. On device they may not: React Native's global fetch is whatwg-fetch
 * over XMLHttpRequest and its Response has no `body`, so token-by-token chat
 * and the Shell tab were silently broken for the entire time the suite was
 * green. Nothing could have caught it, because nothing runs where it happens.
 *
 * These probes close that gap. They are deliberately cheap and side-effect
 * free so they can ship in release builds — the release build is the one whose
 * engine is in question, and `src/app/dev/*` redirects away outside __DEV__.
 */
export type EnvironmentCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  /** False means a nicety; true means a shipped feature depends on it. */
  critical: boolean;
};

function has(scope: Record<string, unknown>, name: string): boolean {
  return typeof scope[name] === 'function' || typeof scope[name] === 'object';
}

/**
 * Globals, checked without a network call.
 *
 * `atob`/`btoa`/`TextEncoder` are reported but not critical: the app stopped
 * depending on them (see `src/lib/encoding.ts`) precisely because nothing
 * installs them. They stay on the report so a future regression that
 * reintroduces the dependency is visible rather than silent.
 */
export function probeRuntimeGlobals(
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): EnvironmentCheck[] {
  const responseBody = (() => {
    const Ctor = scope.Response as { prototype?: object } | undefined;
    if (!Ctor?.prototype) return false;
    return 'body' in Ctor.prototype;
  })();

  return [
    {
      id: 'global-fetch-streaming',
      label: 'Global fetch exposes response.body',
      ok: responseBody,
      detail: responseBody
        ? 'The platform fetch can stream. Nothing depends on this — the app installs its own.'
        : 'Expected on React Native. Streaming goes through expo/fetch instead; see the live check below.',
      critical: false,
    },
    {
      id: 'text-decoder',
      label: 'TextDecoder',
      ok: has(scope, 'TextDecoder'),
      detail: 'Decodes SSE frames and shell output. Installed by Expo, not React Native.',
      critical: true,
    },
    {
      id: 'readable-stream',
      label: 'ReadableStream',
      ok: has(scope, 'ReadableStream'),
      detail: 'Backs every incremental read. Injected by Metro.',
      critical: true,
    },
    {
      id: 'url',
      label: 'URL / URLSearchParams',
      ok: has(scope, 'URL') && has(scope, 'URLSearchParams'),
      detail: 'Gateway address parsing.',
      critical: true,
    },
    {
      id: 'base64',
      label: 'atob / btoa',
      ok: has(scope, 'atob') && has(scope, 'btoa'),
      detail: 'Not required: base64 is implemented in src/lib/encoding.ts because neither React Native nor Expo installs these.',
      critical: false,
    },
    {
      id: 'text-encoder',
      label: 'TextEncoder',
      ok: has(scope, 'TextEncoder'),
      detail: 'Not required: UTF-8 encoding is implemented in src/lib/encoding.ts for the same reason.',
      critical: false,
    },
  ];
}

/**
 * The check that matters: can this build actually read a response
 * incrementally? Hits the gateway's unauthenticated `/health`, which is cheap
 * and has no side effects, and asks for a reader rather than the body text.
 */
export async function probeStreamingFetch(healthUrl: string): Promise<EnvironmentCheck> {
  const base = {
    id: 'streaming-fetch-live',
    label: 'Live: response body is readable',
    critical: true,
  };
  try {
    const response = await streamingFetch(healthUrl);
    const reader = response.body?.getReader?.();
    if (!reader) {
      return {
        ...base,
        ok: false,
        detail:
          'The installed fetch returned a response with no readable body. Streaming chat and the Shell tab cannot work in this build.',
      };
    }
    const { value } = await reader.read();
    await reader.cancel().catch(() => undefined);
    return {
      ...base,
      ok: true,
      detail: `Read ${value?.byteLength ?? 0} bytes incrementally from ${healthUrl}.`,
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
