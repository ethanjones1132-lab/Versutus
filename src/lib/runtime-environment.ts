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
 * How long the live probe waits for the response headers, and then for its
 * first chunk. Both are injectable so a test can drive the deadline without
 * spending it.
 *
 * A bound is what makes this screen a diagnostic rather than a symptom. A
 * half-open Tailscale/DERP path accepts the connection and then says nothing,
 * which is exactly the failure an operator opens this screen to diagnose — and
 * an unbounded probe reproduces it by hanging here instead of naming it. Every
 * other network probe in this area bounds itself (`probeGatewayUrl` arms a
 * timer against its own AbortController); this one did not, which made it the
 * only unbounded call site on the app's one on-device loop.
 */
export const PROBE_HEADER_TIMEOUT_MS = 8_000;
export const PROBE_FIRST_CHUNK_TIMEOUT_MS = 8_000;

/** Options for the live probe; the defaults are the shipped bounds. */
export type ProbeStreamingFetchOptions = {
  headerTimeoutMs?: number;
  firstChunkTimeoutMs?: number;
};

function timeoutDetail(ms: number): string {
  return `The gateway did not answer within ${ms / 1000} s`;
}

/**
 * Race `work` against a deadline that both rejects and aborts `controller`.
 *
 * The abort is what actually unblocks a stalled read where the engine honours
 * `init.signal`; the rejection is what settles the probe regardless, because a
 * peer that ignores the signal must not pin the screen. As in
 * `HttpTransport.request`, only this controller ever aborts it, so an
 * `AbortError` here IS the timeout rather than something to re-report raw.
 */
function withDeadline<T>(
  ms: number,
  work: Promise<T>,
  controller: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(timeoutDetail(ms)));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The check that matters: can this build actually read a response
 * incrementally? Hits the gateway's unauthenticated `/health`, which is cheap
 * and has no side effects, and asks for a reader rather than the body text.
 *
 * Bounded twice over — headers, then the first chunk — because those are the
 * two awaits a half-open path can swallow. A timeout is reported as a failed
 * check that names the deadline, never as a hang, so the caller always gets an
 * answer it can render and retry.
 */
export async function probeStreamingFetch(
  healthUrl: string,
  options: ProbeStreamingFetchOptions = {},
): Promise<EnvironmentCheck> {
  const base = {
    id: 'streaming-fetch-live',
    label: 'Live: response body is readable',
    critical: true,
  };
  const headerTimeoutMs = options.headerTimeoutMs ?? PROBE_HEADER_TIMEOUT_MS;
  const firstChunkTimeoutMs = options.firstChunkTimeoutMs ?? PROBE_FIRST_CHUNK_TIMEOUT_MS;
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await withDeadline(
      headerTimeoutMs,
      streamingFetch(healthUrl, { signal: controller.signal }),
      controller,
    );
    reader = response.body?.getReader?.();
    if (!reader) {
      return {
        ...base,
        ok: false,
        detail:
          'The installed fetch returned a response with no readable body. Streaming chat and the Shell tab cannot work in this build.',
      };
    }
    const { value } = await withDeadline(
      firstChunkTimeoutMs,
      reader.read() as Promise<ReadableStreamReadResult<Uint8Array>>,
      controller,
    );
    return {
      ...base,
      ok: true,
      detail: `Read ${value?.byteLength ?? 0} bytes incrementally from ${healthUrl}.`,
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      // Only this function's deadline aborts the controller, so an abort here is
      // the deadline firing whatever the transport threw on the way down.
      detail: controller.signal.aborted
        ? timeoutDetail(
            reader ? firstChunkTimeoutMs : headerTimeoutMs,
          )
        : error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    // Best effort release only: a peer that ignores cancel() must not pin an
    // already-settled probe. Sync throws and late rejections are swallowed.
    try {
      const releasing = reader?.cancel() as Promise<void> | undefined;
      releasing?.catch?.(() => undefined);
    } catch {
      // cancel threw synchronously; there is nothing left to release.
    }
  }
}
