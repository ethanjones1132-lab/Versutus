export const anthropicProfile = {
  id: 'anthropic',
  label: 'Anthropic API',
  providerType: 'anthropic',
  mode: 'api_key',
  protocol: 'anthropic_messages',
  origins: ['https://api.anthropic.com'],
  modelsPath: '/models',
  authHeaders(credential) {
    return {
      'x-api-key': credential,
      'anthropic-version': '2023-06-01',
    };
  },
  parseModels(payload, providerId) {
    return (payload?.data ?? []).map((model) => ({
      providerId,
      id: model.id,
      label: model.display_name ?? model.id,
      available: true,
    }));
  },
};
