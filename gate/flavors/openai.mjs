/**
 * OpenAI-compatible chat codec. Auth lookup and origin policy live in
 * provider profiles; this module only encodes requests/responses.
 */

/**
 * Build a fetch request for OpenAI-compatible chat completions endpoint.
 *
 * @param {object} config - Flavor configuration
 * @param {string} config.baseUrl - Base URL (e.g., 'https://api.x.ai/v1')
 * @param {string[]} config.models - List of available models
 * @param {string} apiKey - API key for authorization
 * @param {object} options - Request options
 * @param {string} [options.model] - Model name (defaults to first in config.models)
 * @param {Array} options.messages - Chat messages
 * @param {boolean} [options.stream] - Whether to stream responses
 * @returns {object} { url, init } - Fetch request parameters
 * @throws {Error} If requested model is not in config.models
 */
export function buildChatRequest(config, apiKey, options) {
  // Validate and resolve model
  const model = options.model || config.models[0];
  if (!config.models.includes(model)) {
    throw new Error(`Model ${model} not found in configured models`);
  }

  // Build URL
  const url = `${config.baseUrl}/chat/completions`;

  // Build request body
  const body = {
    model,
    messages: options.messages,
  };

  if (options.stream !== undefined) {
    body.stream = options.stream;
  }

  // Build request init
  const init = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };

  return { url, init };
}

/**
 * Parse a text delta from an OpenAI-compatible SSE chunk.
 *
 * @param {string} data - Raw SSE chunk data (JSON string)
 * @returns {string} Text content from delta, or empty string if missing/invalid
 */
export function parseDelta(data) {
  try {
    const chunk = JSON.parse(data);
    return chunk.choices?.[0]?.delta?.content ?? '';
  } catch {
    // If JSON parsing fails or structure is missing, return empty string
    return '';
  }
}

/**
 * The failure a vendor announced inside an SSE stream, if this chunk is one.
 *
 * An OpenAI-compatible endpoint is free to close a turn with `{"error":{...}}`
 * (a proxy's own refusal, a gateway's quota message) after some deltas have
 * already been relayed. `parseDelta` answers `''` for such a frame, and an empty
 * delta is indistinguishable from "no text this frame" — so the relay read on to
 * a clean close and reported success. Returns null for every frame that is not
 * an error, so the relay only has to ask.
 *
 * @param {string} data - Raw SSE chunk data (JSON string)
 * @returns {{message: string, code?: string}|null}
 */
export function parseStreamError(data) {
  try {
    const chunk = JSON.parse(data);
    if (!chunk?.error) return null;
    return {
      message: typeof chunk.error === 'string' ? chunk.error : chunk.error.message ?? 'the provider ended the stream with an error',
      code: typeof chunk.error === 'string' ? undefined : chunk.error.code,
    };
  } catch {
    return null;
  }
}

/** Extract the assistant's text from a non-streaming chat completion. */
export function parseResponseText(json) {
  return json?.choices?.[0]?.message?.content ?? '';
}
