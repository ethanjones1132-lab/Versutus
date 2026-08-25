// Opt-in web-browser access (CORS) for the Gate.
//
// The Versutus app talks to the Gate from React Native, where the same-origin
// policy does not exist. The SAME app running in a phone BROWSER — the web
// dev-server demo target in pilot-runbook-v1.md §0 — sits on Metro's port and
// is cross-origin against the Gate's port, so the browser blocks every fetch
// (manifest, pairing, runs, SSE replay) before it ever reaches the router.
//
// The operator opts in by naming the exact origins that may call the Gate:
//
//   node gate/cli.mjs start --allow-origin http://192.168.1.20:8081
//   VERSUTUS_GATE_ALLOW_ORIGIN="http://a:8081,https://b.example.ts.net:8081"
//
// Posture: nothing changes until an origin is named; allowed values are
// matched exactly and echoed back (never a reflected wildcard); the Gate is
// bearer-token authenticated with no cookies, so CORS grants visibility, not
// authority. A preflight is answered here, centrally, because no route owns
// OPTIONS and browsers send it without credentials.

const ALLOWED_METHODS = 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS';

/** "http://A:8081, https://b" -> ["http://a:8081","https://b"] (trimmed, lowercased, deduped). */
export function parseAllowedOrigins(raw) {
  if (typeof raw !== 'string') return [];
  return [...new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  )];
}

/**
 * Apply web-CORS state to one request.
 *
 * Returns true when the request was fully handled here (an answered OPTIONS
 * preflight — the caller must stop routing). For every other request it
 * attaches Access-Control-Allow-Origin when the caller's origin is on the
 * allow-list, then returns false so the router proceeds untouched. With no
 * origins configured this is a no-op: byte-for-byte the Gate of before.
 */
export function webCors(req, res, rawList = process.env.VERSUTUS_GATE_ALLOW_ORIGIN) {
  const allowed = parseAllowedOrigins(rawList);
  if (allowed.length === 0) return false;

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  if (origin && allowed.includes(origin.toLowerCase())) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  if (req.method !== 'OPTIONS') return false;

  // Preflight. An origin that is not listed gets no ACAO header, so the
  // browser refuses to send the real call — deny stays silent, like today.
  res.statusCode = 204;
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  const requestHeaders = req.headers['access-control-request-headers'];
  if (typeof requestHeaders === 'string' && requestHeaders.trim()) {
    res.setHeader('Access-Control-Allow-Headers', requestHeaders.trim());
  }
  res.setHeader('Access-Control-Max-Age', '600');
  res.end();
  return true;
}
