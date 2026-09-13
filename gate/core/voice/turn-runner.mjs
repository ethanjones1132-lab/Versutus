// ─── One turn runner behind typed and spoken turns ───────────────────────
// A typed chat turn (`/v1/chat/completions` SSE) and a spoken voice turn run
// the same backend turn. Both subscribe before sending so no opening delta is
// lost, surface reply text and tool calls as they arrive, and agree on what
// "the turn produced something" means, so a silent turn is an error rather
// than a clean finish.

const NOOP = () => {};

/**
 * The model that actually answered, alongside the one the caller asked for.
 *
 * Backends are allowed to substitute — Hermes does it silently through
 * `fallback_providers` — and they report it in a runtime block. Reporting only
 * the request would keep repeating the operator's own choice back at them.
 * Absent runtime means the backend cannot tell us: say what was asked.
 */
export function modelReport(runtime, requested) {
  const ran = runtime?.model ?? requested?.modelId;
  const asked = runtime?.requested?.model ?? requested?.modelId;
  const report = {};
  if (ran) report.model = ran;
  if (asked) report.requested_model = asked;
  if (runtime?.provider) report.provider = runtime.provider;
  return report;
}

/**
 * Relay an OpenAI-shaped upstream stream, reporting what the caller cares
 * about. Payloads pass through unchanged -- Hermes and the Gate write the same
 * chunk shape, so translating would only add a place to get it wrong. `[DONE]`
 * is held back so the caller writes exactly one terminator, and unparseable
 * frames are forwarded rather than dropped.
 *
 * @returns whether anything the user could see came through.
 */
async function relayStreamingTurn(upstream, { onDelta, onToolCall, onChunk, signal }) {
  const reader = upstream.body?.getReader?.();
  if (!reader) return false;

  const decoder = new TextDecoder();
  let buffer = '';
  let sawContent = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);

      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n');
      if (!data || data === '[DONE]') continue;

      onChunk(data);
      try {
        const delta = JSON.parse(data)?.choices?.[0]?.delta;
        if (delta?.content) {
          sawContent = true;
          onDelta(delta.content);
        }
        if (delta?.tool_calls?.length) {
          sawContent = true;
          for (const call of delta.tool_calls) {
            onToolCall({ index: call.index ?? 0, name: call.function?.name, callId: call.id });
          }
        }
      } catch {
        // Opaque frame: relayed verbatim, nothing to report to the caller.
      }
    }
  }
  return sawContent;
}

/**
 * Run one backend turn, reporting each visible piece through callbacks.
 *
 * @param {object} backend A CLI backend (sendMessage/streamEvents, or the
 *   one-call sendMessageStreaming Hermes uses).
 * @param {string} sessionId
 * @param {{ text: string, model?: object }} input
 * @param {{
 *   onDelta?: (text: string) => void,
 *   onToolCall?: (call: { index: number, name?: string, callId?: string }) => void,
 *   onApproval?: (approval: object) => void,
 *   onChunk?: (data: string) => void,
 *   signal?: AbortSignal,
 * }} handlers `onChunk` carries the raw OpenAI-shaped payload for callers that
 *   relay bytes verbatim; `onDelta`/`onToolCall`/`onApproval` are the parsed
 *   events a voice loop consumes.
 * @returns {Promise<{ hasContent: boolean, report: object, aborted?: boolean }>}
 */
export async function runBackendTurn(backend, sessionId, { text, model } = {}, {
  onDelta = NOOP,
  onToolCall = NOOP,
  onApproval = NOOP,
  onChunk = NOOP,
  signal,
} = {}) {
  // The caller owns the outer signal; this controller lets the runner stop the
  // event subscription once the turn is done even though it cannot abort the
  // caller's signal itself.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    // Hermes sends and streams in one POST, which does not fit the
    // subscribe-then-send shape below, so it is handled as its own path.
    if (typeof backend.sendMessageStreaming === 'function') {
      let upstream = null;
      try {
        upstream = await backend.sendMessageStreaming(sessionId, { text, model }, controller.signal);
      } catch {
        // Nothing has been written yet, so the whole-turn path below can still
        // serve this turn -- unless the caller walked away.
        upstream = null;
        if (signal?.aborted) return { hasContent: false, report: {}, aborted: true };
      }

      if (upstream) {
        const hasContent = await relayStreamingTurn(upstream, {
          onDelta,
          onToolCall,
          onChunk,
          signal: controller.signal,
        });
        return { hasContent, report: {} };
      }
    }

    let toolIndex = 0;
    const seenTools = new Map();
    // A tool call is real turn activity with no closing text of its own -- only
    // a turn where *neither* text nor a tool ever happened counts as empty.
    let sawContent = false;

    const streaming = backend
      .streamEvents(
        sessionId,
        (event) => {
          if (event.type === 'message.delta' && event.payload?.text) {
            sawContent = true;
            onDelta(event.payload.text);
            onChunk(JSON.stringify({ choices: [{ delta: { content: event.payload.text } }] }));
            return;
          }
          if (event.type === 'tool.started' && event.payload?.name) {
            if (seenTools.has(event.payload.callId)) return;
            sawContent = true;
            const index = toolIndex++;
            seenTools.set(event.payload.callId, index);
            onToolCall({ index, name: event.payload.name, callId: event.payload.callId });
            onChunk(JSON.stringify({
              choices: [{ delta: { tool_calls: [{ index, function: { name: event.payload.name } }] } }],
            }));
            return;
          }
          if (event.type === 'approval.required') {
            onApproval(event.payload);
          }
        },
        controller.signal,
      )
      .catch(() => undefined);

    try {
      const result = await backend.sendMessage(sessionId, { text, model });
      const hasContent = sawContent
        || Boolean(result?.text && result.text.trim())
        || Boolean(result?.message?.tool_calls?.length);

      // A backend whose `streamEvents` is a no-op finishes the turn with real
      // text that never reached the wire. Send it as one delta rather than
      // dropping it -- and only when nothing streamed, so a backend that does
      // emit events is not echoed twice.
      if (!sawContent && result?.text && result.text.trim()) {
        onDelta(result.text);
        onChunk(JSON.stringify({ choices: [{ delta: { content: result.text } }] }));
      }

      return { hasContent, report: modelReport(result?.runtime, model) };
    } finally {
      controller.abort();
      await streaming;
    }
  } finally {
    signal?.removeEventListener('abort', forwardAbort);
  }
}
