const SENSITIVE_KEYS = new Set([
  'apikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'token',
  'password',
  'secret',
  'credential',
  'authorization',
  'bearer',
  'xapikey',
  'privatekey',
  'sessiontoken',
]);

function normaliseKey(key) {
  return String(key).toLowerCase().replace(/[_\-\s]/g, '');
}

export function redactSensitive(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) return '[redacted]';
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map((item) => redactSensitive(item, seen));
  } else {
    out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(normaliseKey(key))) {
        out[key] = '[redacted]';
      } else {
        out[key] = redactSensitive(item, seen);
      }
    }
  }
  seen.delete(value);
  return out;
}

const SENSITIVE_KEY_SOURCE = [
  'x[_-]?api[_-]?key',
  'api[_-]?key',
  'access[_-]?token',
  'refresh[_-]?token',
  'id[_-]?token',
  'client[_-]?secret',
  'private[_-]?key',
  'session[_-]?token',
  'authorization',
  'bearer',
  'credential',
  'password',
  'secret',
  'token',
].join('|');

const BEARER_PATTERN = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_TOKEN_PATTERN = /\b(?:sk-|sk_|gsk_|xai-|ghp_|github_pat_)[A-Za-z0-9_-]{20,}\b/g;
const QUOTED_PAIR_PATTERN = new RegExp(
  `(["']?)(${SENSITIVE_KEY_SOURCE})\\1(\\s*[:=]\\s*)(["'])([^"']*)\\4`,
  'gi',
);
const UNQUOTED_PAIR_PATTERN = new RegExp(
  `(?<![\\w-])(${SENSITIVE_KEY_SOURCE})(\\s*[:=]\\s*)(?!\\s*(?:bearer|basic)\\b)(?!\\s*\\[redacted\\])([^\\s,;'"}\\]]+)`,
  'gi',
);

export function redactSensitiveText(text, secrets = []) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  out = out.replace(BEARER_PATTERN, '[redacted]');
  out = out.replace(KEY_TOKEN_PATTERN, '[redacted]');
  out = out.replace(QUOTED_PAIR_PATTERN, (match, keyQuote, key, separator, valQuote) => `${keyQuote}${key}${keyQuote}${separator}${valQuote}[redacted]${valQuote}`);
  out = out.replace(UNQUOTED_PAIR_PATTERN, (match, key, separator, val) => `${key}${separator}[redacted]`);
  const literals = secrets
    .filter((s) => typeof s === 'string' && s.length >= 6)
    .sort((a, b) => b.length - a.length);
  for (const secret of literals) {
    // split/join takes a literal separator, so regex metacharacters in the
    // secret (JWT dots, ya29., sk-proj., + and = in passwords) still match.
    out = out.split(secret).join('[redacted]');
  }
  return out;
}
