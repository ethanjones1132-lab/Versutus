export const openaiProfile = {
  id: 'openai',
  label: 'OpenAI API',
  providerType: 'openai',
  mode: 'api_key',
  protocol: 'openai_chat',
  origins: ['https://api.openai.com'],
  defaultBaseUrl: 'https://api.openai.com/v1',
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
};
