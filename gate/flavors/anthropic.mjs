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

/** Extract the text delta from one Messages API SSE event's data payload. */
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

/** Join the text blocks of a non-streaming Messages API response. */
export function parseResponseText(json) {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  return blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('');
}
