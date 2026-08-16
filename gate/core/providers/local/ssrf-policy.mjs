export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_HEADER_BYTES = 16 * 1024;
export const MAX_REDIRECTS = 2;
export const MAX_STREAM_BYTES = 1024 * 1024;

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

export async function readLimited(response, maxBytes = MAX_BODY_BYTES) {
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
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('response body is oversized');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function readJsonLimited(response, maxBytes = MAX_BODY_BYTES) {
  const buffer = await readLimited(response, maxBytes);
  return JSON.parse(buffer.toString('utf8'));
}
