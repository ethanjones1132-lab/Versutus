export const id = 'nvidia';
export const label = 'NVIDIA NIM';

// ─── CONFIG: edit only inside this block ───────────────
export const config = {
  flavor: 'openai',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  apiKeyEnv: 'NVIDIA_API_KEY',
  models: ['deepseek-ai/deepseek-v4-flash-0731', 'meta/llama-3.1-8b-instruct'],
  capabilities: { chat: true, streaming: true },
};
// ─── END CONFIG ────────────────────────────────────────
