export const nvidiaNimProfile = {
  id: 'nvidia-nim',
  label: 'NVIDIA NIM',
  providerType: 'nvidia-nim',
  mode: 'api_key',
  protocol: 'openai_chat',
  origins: ['https://integrate.api.nvidia.com'],
  defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
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
