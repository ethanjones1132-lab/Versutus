/**
 * Any endpoint that speaks the OpenAI chat/models dialect at a URL the operator
 * supplies — OpenCode Zen, a self-hosted vLLM or NIM, an inference gateway.
 *
 * `origins` is empty on purpose: the adapter allowlists the origin of the
 * registered base URL, so the operator's own choice is the boundary. There is
 * no default base URL because there is no canonical host to guess.
 */
export const openaiCompatibleProfile = {
  id: 'openai-compatible',
  label: 'OpenAI-compatible',
  providerType: 'openai-compatible',
  mode: 'api_key',
  protocol: 'openai_chat',
  origins: [],
  modelsPath: '/models',
  authHeaders(credential) {
    return { Authorization: `Bearer ${credential}` };
  },
  parseModels(payload, providerId) {
    return (payload?.data ?? []).map((model) => ({
      providerId,
      id: model.id,
      label: model.id,
      available: true,
    }));
  },
  keepBootstrapIfEmpty: true,
};
