/**
 * Any endpoint that speaks the OpenAI chat/models dialect at a URL the operator
 * supplies — OpenCode Zen, a self-hosted vLLM or NIM, an inference gateway.
 *
 * `origins` is empty on purpose: the adapter allowlists the origin of the
 * registered base URL, so the operator's own choice is the boundary. There is
 * no default base URL because there is no canonical host to guess.
 */
// OpenCode Go began refusing every request without a stable `x-opencode-session`
// header (400 MissingSessionID, 2026-09-05); Zen accepts it too. The value is
// opaque — only stability across a conversation matters — so the adapter mints
// one per registration and this profile sends it for OpenCode hosts.
const OPENCODE_SESSION_HEADER = 'x-opencode-session';

function isOpenCodeEndpoint(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}

export const openaiCompatibleProfile = {
  id: 'openai-compatible',
  label: 'OpenAI-compatible',
  providerType: 'openai-compatible',
  mode: 'api_key',
  protocol: 'openai_chat',
  origins: [],
  modelsPath: '/models',
  authHeaders(credential, context = {}) {
    const headers = { Authorization: `Bearer ${credential}` };
    if (context.sessionId && isOpenCodeEndpoint(context.baseUrl)) {
      headers[OPENCODE_SESSION_HEADER] = context.sessionId;
    }
    return headers;
  },
  parseModels(payload, providerId) {
    return (payload?.data ?? []).map((model) => ({
      providerId,
      id: model.id,
      label: model.id,
      available: true,
    }));
  },
};
