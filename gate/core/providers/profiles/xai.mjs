export const xaiProfile = {
  id: 'xai',
  label: 'xAI API',
  providerType: 'xai',
  mode: 'api_key',
  protocol: 'openai_chat',
  origins: ['https://api.x.ai'],
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
