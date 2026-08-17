import { filterModels } from '@/lib/gateway/model-selection';

const models = [
  { id: 'claude-opus-5', provider: 'Anthropic', providerId: 'anthropic' },
  { id: 'gpt-5', provider: 'OpenAI', providerId: 'openai' },
  { id: 'llama-3-70b', provider: 'Groq', providerId: 'groq' },
];

describe('filterModels', () => {
  test('returns the same reference for an empty query', () => {
    expect(filterModels(models, '')).toBe(models);
    expect(filterModels(models, '   ')).toBe(models);
  });

  test('matches on model id, case-insensitively', () => {
    expect(filterModels(models, 'OPUS').map((m) => m.id)).toEqual(['claude-opus-5']);
  });

  test('matches on a partial id', () => {
    expect(filterModels(models, '70b').map((m) => m.id)).toEqual(['llama-3-70b']);
  });

  test('matches on provider display name', () => {
    expect(filterModels(models, 'openai').map((m) => m.id)).toEqual(['gpt-5']);
  });

  test('matches on provider id', () => {
    expect(filterModels(models, 'groq').map((m) => m.id)).toEqual(['llama-3-70b']);
  });

  test('returns nothing when there is no match', () => {
    expect(filterModels(models, 'gemini')).toEqual([]);
  });

  test('tolerates models with no provider fields', () => {
    const sparse = [{ id: 'bare-model' }];
    expect(filterModels(sparse, 'bare').map((m) => m.id)).toEqual(['bare-model']);
    expect(filterModels(sparse, 'anthropic')).toEqual([]);
  });
});
