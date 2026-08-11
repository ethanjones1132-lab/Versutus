/**
 * Anthropic Messages API flavor.
 *
 * Three differences from the openai.mjs dialect: `max_tokens` is required,
 * a system prompt is a top-level `system` field rather than a
 * `role: "system"` message, and auth is `x-api-key` / `anthropic-version`
 * headers instead of a bearer token.
 */

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Build a fetch request for Anthropic Messages API endpoint.
 *
 * @param {object} config - Flavor configuration
 * @param {string} config.baseUrl - Base URL (e.g., 'https://api.anthropic.com/v1')
 * @param {string[]} config.models - List of available models
 * @param {string} apiKey - API key for authorization
 * @param {object} options - Request options
 * @param {string} [options.model] - Model name (defaults to first in config.models)
 * @param {Array} options.messages - Chat messages (system messages are extracted to top-level system field)
 * @param {boolean} [options.stream] - Whether to stream responses
 * @param {number} [options.maxTokens] - Max tokens (defaults to 4096)
 * @returns {object} { url, init } - Fetch request parameters
 * @throws {Error} If requested model is not in config.models
 */
export function buildChatRequest(config, apiKey, { model, messages, stream = false, maxTokens }) {
  const target = model ?? config.models[0];
  if (!config.models.includes(target)) {
    throw new Error(
      `model "${target}" is not declared by this provider (declared: ${config.models.join(', ')})`,
    );
  }

  const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const rest = messages.filter((m) => m.role !== 'system');

  const body = {
    model: target,
    max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: rest,
    stream,
  };
  if (systemParts.length > 0) body.system = systemParts.join('\n\n');

  return {
    url: `${config.baseUrl.replace(/\/+$/, '')}/messages`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    },
  };
}

/**
 * Parse a text delta from an Anthropic Messages API SSE chunk.
 *
 * @param {string} data - Raw SSE chunk data (JSON string)
 * @returns {string} Text content from delta, or empty string if missing/invalid
 */
export function parseDelta(data) {
  try {
    const parsed = JSON.parse(data);
    if (parsed?.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
      return parsed.delta.text ?? '';
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Extract the assistant's text from a non-streaming Messages API response.
 *
 * @param {object} json - Parsed JSON response from Messages API
 * @returns {string} Joined text from all text blocks, or empty string if none present
 */
export function parseResponseText(json) {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  return blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('');
}
