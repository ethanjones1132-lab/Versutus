// ─── Why the Gate refused a request, without saying what was refused ──────
// A 401 carried no record on the host. On 2026-09-16 the phone's Shell tab got
// "Terminal stream failed (401)" while the same phone listed all 15 Bots, and
// the Gate's log held nothing to tell a missing header from a wrong token. This
// names the route and the SHAPE of the credential that arrived — present or
// absent, bearer or not, and its length — which is enough to separate "the
// client sent nothing" from "the client sent a stale token". It never prints
// the token or any part of it.

export function describeAuthFailure({ method, pathname, authorization }) {
  const route = `${method} ${pathname}`;
  if (typeof authorization !== 'string' || authorization.length === 0) {
    return `auth refused: ${route} - no authorization header`;
  }
  const match = /^Bearer\s*(.*)$/i.exec(authorization);
  if (!match) return `auth refused: ${route} - authorization header is not a bearer`;
  const token = match[1].trim();
  if (token.length === 0) return `auth refused: ${route} - empty bearer`;
  return `auth refused: ${route} - bearer present (${token.length} chars) matches no Gate or device token`;
}
