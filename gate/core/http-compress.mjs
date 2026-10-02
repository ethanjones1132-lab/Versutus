// gzip for the answers the phone pays for in bytes, and nothing else.
//
// The Gate answers a phone that may be sitting on a DERP relay over cellular,
// where every byte is slow: the model catalogue alone is ~241 KB of JSON per
// read, and React Native's fetch (OkHttp on Android) already sends
// `Accept-Encoding: gzip` and inflates the answer itself. So the Gate was
// paying for the full uncompressed catalogue on a link that charges for it.
//
// Only a whole answer is compressed. A stream must reach the phone frame by
// frame, so the first `res.write()` — or a `Content-Type` of text/event-stream,
// or a response that already carries a `Content-Encoding` — hands the response
// back to `node:http` untouched and every later call goes straight to it, with
// no buffering and no added latency.
//
// `writeHead` is deferred rather than passed through, because the decision needs
// a body that only `end()` has. `res.headersSent` is answered from the deferred
// call so the routes that check it (`if (res.headersSent) res.end()`) keep
// reading the same thing they read before.

import { promisify } from 'node:util';
import { gzip as zlibGzip } from 'node:zlib';

// Off the event loop: zlib's threadpool, so a catalogue-sized gzip does not
// stall every other phone's SSE frame. Injectable as sync or async so a
// failure (or a test) can still drive the path.
const gzipAsync = promisify(zlibGzip);

// A body this small costs more in framing than gzip saves, and answering it
// compressed makes a cache entry harder to reuse.
const DEFAULT_MIN_BYTES = 1024;

// These carry no body by definition; a header promising one is a lie either way.
const BODYLESS_STATUSES = new Set([204, 304]);

/**
 * Does the client accept a gzip answer?
 *
 * `gzip;q=0` is a refusal and means no. `*` is not read as consent: only gzip
 * being named as acceptable counts.
 */
export function acceptsGzip(req) {
  const raw = req?.headers?.['accept-encoding'];
  const header = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof header !== 'string') return false;
  for (const entry of header.split(',')) {
    const [name, ...parameters] = entry.split(';');
    if (name.trim().toLowerCase() !== 'gzip') continue;
    let quality = 1;
    for (const parameter of parameters) {
      const [key, value] = parameter.split('=');
      if (key.trim().toLowerCase() !== 'q') continue;
      const parsed = Number.parseFloat(value);
      quality = Number.isFinite(parsed) ? parsed : 0;
    }
    return quality > 0;
  }
  return false;
}

/** Add a field to a Vary header without dropping what is already there. */
function appendVary(current, field) {
  if (Array.isArray(current)) current = current.join(', ');
  if (typeof current !== 'string' || current.trim() === '') return field;
  return /(^|,)\s*accept-encoding\s*(,|$)/i.test(current) ? current : `${current}, ${field}`;
}

/** `writeHead`'s headers as name/value pairs, in either accepted shape. */
function headerPairs(headers) {
  if (Array.isArray(headers)) return headers.filter((entry) => Array.isArray(entry));
  if (headers && typeof headers === 'object') return Object.entries(headers);
  return [];
}

/** The value a header will actually carry, writeHead's own argument winning. */
function effectiveHeader(pending, res, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of headerPairs(pending?.headers)) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return res.getHeader(name);
}

/** Is this response a stream that must be passed through as it is written? */
function isStreamResponse(pending, res, streamingType) {
  if (streamingType) return true;
  const type = effectiveHeader(pending, res, 'Content-Type');
  if (typeof type === 'string' && type.trim().toLowerCase().startsWith('text/event-stream')) return true;
  return effectiveHeader(pending, res, 'Content-Encoding') !== undefined;
}

function bodyBytes(chunk, encoding) {
  if (chunk === undefined || chunk === null) return null;
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding || 'utf8');
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  // Anything else is a route's mistake: node:http must be the one to say so.
  return null;
}

/** The callback `end(chunk, encoding, callback)` may be carrying. */
function endCallback(chunk, encoding, callback) {
  if (typeof chunk === 'function') return chunk;
  if (typeof encoding === 'function') return encoding;
  return typeof callback === 'function' ? callback : undefined;
}

/**
 * Node's own reading of `headersSent`, which is a getter on the prototype.
 * Captured through the chain (rather than read once) because the wrapper below
 * puts its own `headersSent` on the instance, and a getter read off the
 * instance would just call the wrapper again.
 */
function nativeHeadersSent(res) {
  for (let target = Object.getPrototypeOf(res); target; target = Object.getPrototypeOf(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, 'headersSent');
    if (descriptor?.get) return descriptor.get.call(res) === true;
  }
  return false;
}

/**
 * Compress a one-shot JSON answer for clients that accept gzip.
 *
 * Call once per request, before any route touches the response. Returns `res`
 * unchanged when compression does not apply (no gzip accepted, a HEAD), so the
 * caller needs no branch of its own.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ minBytes?: number, gzip?: (body: Buffer) => Buffer | Promise<Buffer> }} [options]
 *   `gzip` is the compression step, injectable so a failure can be tested.
 *   The default is async (libuv threadpool) so a large answer cannot stall
 *   every other request on the Gate's single event loop.
 * @returns {import('node:http').ServerResponse} the same response
 */
export function enableJsonCompression(req, res, { minBytes = DEFAULT_MIN_BYTES, gzip = gzipAsync } = {}) {
  if (req.method === 'HEAD') return res;
  if (!acceptsGzip(req)) return res;
  if (res.headersSent || res.writableEnded) return res;

  const original = {
    writeHead: res.writeHead,
    setHeader: res.setHeader,
    removeHeader: res.removeHeader,
    write: res.write,
    end: res.end,
  };
  const call = (name, args) => original[name].apply(res, args);
  const restore = () => {
    for (const [name, method] of Object.entries(original)) res[name] = method;
  };

  // `pending` is a status line held back until the body says which shape it is;
  // `committed` is that status line on the wire. `streamingType` remembers an
  // event-stream Content-Type set before any status line was written.
  let pending = null;
  let committed = false;
  let streamingType = false;

  /** Put the route's status line on the wire, headers exactly as it wrote them. */
  const flushPending = ({ withHeaders = true } = {}) => {
    if (!pending || committed) return;
    const held = pending;
    pending = null;
    committed = true;
    if (withHeaders) {
      // Replayed verbatim: node:http merges writeHead's own headers over anything
      // set before it, and its array form carries repeated names that setHeader
      // could not hold.
      call('writeHead', held.args);
      return;
    }
    // The compressed path replays the status line alone. Its headers are already
    // in the store — the route's, with ours applied over them — and replaying the
    // route's own Content-Length here would undo the compressed one.
    if (held.statusMessage === undefined) call('writeHead', [held.statusCode]);
    else call('writeHead', [held.statusCode, held.statusMessage]);
  };

  /** A stream is never compressed: flush what is held and get out of the way. */
  const passThrough = () => {
    restore();
    flushPending();
  };

  // A route that asked for a status line has, to the router, sent one: the
  // error paths that check `res.headersSent` after a streaming writeHead must
  // still see true. `node:http` is told the truth at flushPending().
  Object.defineProperty(res, 'headersSent', {
    configurable: true,
    get: () => committed || Boolean(pending) || nativeHeadersSent(res),
  });

  res.writeHead = function writeHead(statusCode, ...rest) {
    if (committed) {
      // Headers are already on the wire: node:http answers a second writeHead
      // the only way it can, which is what a route relying on that sees today.
      return call('writeHead', arguments);
    }
    // writeHead takes (status[, statusMessage][, headers]), so the last
    // argument is the headers whenever it is an object or an array.
    const last = rest.at(-1);
    const headers = Array.isArray(last) || (last !== null && typeof last === 'object') ? last : undefined;
    const statusMessage = headers === undefined
      ? (typeof last === 'string' ? last : undefined)
      : (typeof rest[0] === 'string' ? rest[0] : undefined);
    const held = { statusCode, statusMessage, headers, args: arguments };
    if (isStreamResponse(held, res, streamingType)) {
      // An event feed has to reach the phone as it is written, so its status
      // line goes out now, unchanged, and its frames are never buffered.
      restore();
      committed = true;
      return call('writeHead', arguments);
    }
    if (pending) {
      // Two status lines before a byte is written: flush the first and let
      // node:http refuse the second, as it does unwrapped.
      flushPending();
      return call('writeHead', arguments);
    }
    for (const [name, value] of headerPairs(held.headers)) res.setHeader(name, value);
    res.statusCode = statusCode;
    pending = held;
    return res;
  };

  res.setHeader = function setHeader(name, value) {
    if (!committed) {
      // A stream can announce itself here instead of in writeHead.
      if (typeof value === 'string' && value.trim().toLowerCase().startsWith('text/event-stream')) {
        streamingType = true;
      }
    }
    return call('setHeader', arguments);
  };

  res.write = function write(chunk, encoding, callback) {
    // The first byte written means this is a stream, not an answer: nothing is
    // buffered behind it and nothing waits on it.
    passThrough();
    return call('write', arguments);
  };

  res.end = function end(chunk, encoding, callback) {
    if (committed) return call('end', arguments);
    const callbackToKeep = endCallback(chunk, encoding, callback);
    const body = bodyBytes(chunk, encoding);
    const statusCode = pending ? pending.statusCode : res.statusCode;
    const compressible = body !== null
      && body.length >= minBytes
      && !BODYLESS_STATUSES.has(statusCode)
      && !isStreamResponse(pending, res, streamingType);

    const sendOriginal = () => {
      flushPending();
      // Same reasoning for the answers left as they were: end() returns only once
      // the response is finished, and nothing after it should be holding a status
      // line hostage.
      pending = null;
      committed = true;
      return call('end', arguments);
    };

    const sendCompressed = (compressed) => {
      if (!Buffer.isBuffer(compressed)) return sendOriginal();
      // The route's own headers are already in the store (writeHead put them
      // there when it was held back); a stale Content-Length must go first.
      res.removeHeader('Content-Length');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', appendVary(res.getHeader('Vary'), 'Accept-Encoding'));
      res.setHeader('Content-Length', String(compressed.length));
      flushPending({ withHeaders: false });
      // A route that wrote no status line of its own still needs this marked:
      // the real end() writes one from inside itself, through the wrapper
      // above, and a status line left pending after the response is finished
      // is state nothing should have to reason about later.
      pending = null;
      committed = true;
      return callbackToKeep ? call('end', [compressed, callbackToKeep]) : call('end', [compressed]);
    };

    if (compressible) {
      let result;
      try {
        result = gzip(body);
      } catch {
        // A failed compression must never cost the answer: send it as it was.
        return sendOriginal();
      }
      if (result && typeof result.then === 'function') {
        result.then(sendCompressed, sendOriginal);
        return res;
      }
      return sendCompressed(result);
    }

    return sendOriginal();
  };

  return res;
}