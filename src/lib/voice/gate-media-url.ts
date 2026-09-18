// ─── Gate media WebSocket URL ─────────────────────────────────────────────
// The phone opens `/v1/voice/stream` on the same host it already talks HTTP
// to. Native code then appends `voiceSessionId`. This fold is the only place
// the scheme is rewritten, so https cannot silently become ws.

/** The websocket URL for the Gate's media socket, from the gateway's HTTP base. */
export function mediaSocketUrl(baseUrl: string, streamPath: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const wsBase = trimmed.startsWith('https:')
    ? `wss:${trimmed.slice('https:'.length)}`
    : trimmed.startsWith('http:')
      ? `ws:${trimmed.slice('http:'.length)}`
      : trimmed;
  const path = streamPath.startsWith('/') ? streamPath : `/${streamPath}`;
  return `${wsBase}${path}`;
}
