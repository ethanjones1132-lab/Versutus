export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_HEADER_BYTES = 16 * 1024;
export const MAX_REDIRECTS = 2;
export const MAX_STREAM_BYTES = 1024 * 1024;

// How much of a local provider's own explanation reaches the card. The body is
// not the Gate's to trust the size of, and `readLimited` exists for the same
// reason on the success path.
export const MAX_DETAIL_BYTES = 512;

// The local path's clock. The remote profiles are bounded for the same reason
// this is (`profiles/registry.mjs`'s `boundedRequest`): fetch has no timeout of
// its own, so a loopback server that accepts the connection and then says
// nothing held the request — and the per-provider check flight behind it —
// until the process did.
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;

/**
 * A signal that ends the request it was given to, on a budget no longer than
 * the ceiling above. The timer is unref'd and must outlive the header wait:
 * clearing it when the Response object exists left a body that never arrived
 * hanging `service.check` for the life of the process. `readLimited` clears it
 * when the body is consumed (or given up on).
 */
export function boundedSignal(timeoutMs) {
  const budgetMs = Math.min(Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, budgetMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    budgetMs,
    get expired() {
      return expired;
    },
    clear() {
      clearTimeout(timer);
    },
  };
}

/**
 * What a local provider said about a refusal, and the body consumed either way.
 *
 * Undici cannot hand an unread body back to its pool, so every 401, 429 and 5xx
 * used to hold its connection; and a status alone tells the operator nothing
 * about a local service that is refusing on purpose.
 */
export async function readDetailLimited(response) {
  let text = '';
  try {
    // Read at the body cap, then truncate the text: reading at the detail cap
    // would throw on a merely long explanation and throw the explanation away.
    text = (await readLimited(response)).toString('utf8');
  } catch {
    await response.body?.cancel?.().catch(() => {});
    return '';
  }
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.length > MAX_DETAIL_BYTES ? ` — ${trimmed.slice(0, MAX_DETAIL_BYTES)}…` : ` — ${trimmed}`;
}

export function isLoopbackHostname(hostname) {
  const host = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function assertLoopbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('manifest URL is not a valid loopback URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('manifest URL protocol is not allowed');
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(`manifest host ${url.hostname} is not loopback`);
  }
  return url;
}

export function assertLoopbackRedirect(location, base) {
  let next;
  try {
    next = new URL(location, base);
  } catch {
    throw new Error('redirect location is invalid');
  }
  if (!isLoopbackHostname(next.hostname)) {
    throw new Error('redirect left loopback');
  }
  return next;
}

/**
 * The header wait and the body read share one clock. `fetchLimited` used to
 * clear the timer the moment the Response existed, so a loopback server that
 * sent headers and then stalled still parked `service.check` forever.
 */
const bodyDeadlines = new WeakMap();

export function bindBodyDeadline(response, bounded) {
  if (response && bounded) bodyDeadlines.set(response, bounded);
}

export function releaseBodyDeadline(response) {
  const bounded = bodyDeadlines.get(response);
  if (bounded) {
    bodyDeadlines.delete(response);
    bounded.clear();
  }
}

function takeBodyDeadline(response) {
  const bounded = bodyDeadlines.get(response);
  if (bounded) bodyDeadlines.delete(response);
  return bounded;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function readChunk(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) {
    const error = new Error('aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      reject(error);
      reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function readLimited(response, maxBytes = MAX_BODY_BYTES) {
  const deadline = takeBodyDeadline(response);
  try {
    let headerBytes = 0;
    for (const [key, value] of response.headers) {
      headerBytes += key.length + String(value).length;
    }
    if (headerBytes > MAX_HEADER_BYTES) {
      throw new Error('response headers are too large');
    }

    if (!response.body) {
      return Buffer.alloc(0);
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await readChunk(reader, deadline?.signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('response body is oversized');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await response.body?.cancel?.().catch(() => {});
    if (deadline && (deadline.expired || isAbortError(error))) {
      const timeout = new Error(`local provider did not answer within ${deadline.budgetMs}ms`);
      timeout.code = 'ETIMEDOUT';
      throw timeout;
    }
    throw error;
  } finally {
    deadline?.clear();
  }
}

export async function readJsonLimited(response, maxBytes = MAX_BODY_BYTES) {
  const buffer = await readLimited(response, maxBytes);
  return JSON.parse(buffer.toString('utf8'));
}
