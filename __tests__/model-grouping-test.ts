import { groupByProvider, OTHER_GROUP_KEY } from '@/lib/gateway/model-selection';

// The model picker renders one collapsible section per provider instead of a
// flat catalog (polish roadmap 2.7). These pins hold the grouping contract:
// providerId is the stable key, provider is the display name, and unattributed
// models stay reachable in one explicit "Other" group rather than vanishing.

test('groups by providerId and names the section by provider', () => {
  const sections = groupByProvider([
    { id: 'gpt-5.4-mini', provider: 'OpenAI', providerId: 'openai' },
    { id: 'z-ai/glm-5.2', provider: 'Z.AI', providerId: 'z-ai' },
  ]);
  expect(sections).toHaveLength(2);
  expect(sections[0]).toEqual({
    key: 'openai',
    title: 'OpenAI',
    data: [{ id: 'gpt-5.4-mini', provider: 'OpenAI', providerId: 'openai' }],
  });
  expect(sections[1].key).toBe('z-ai');
});

test('providerId wins as the key when it differs from the display name', () => {
  const sections = groupByProvider([
    { id: 'laguna-s-2.1-free', provider: 'opencode-zen', providerId: 'opencode-zen' },
    { id: 'deepseek-v4-flash', provider: 'opencode-zen', providerId: 'opencode-zen' },
  ]);
  expect(sections).toEqual([
    {
      key: 'opencode-zen',
      title: 'opencode-zen',
      data: [
        { id: 'laguna-s-2.1-free', provider: 'opencode-zen', providerId: 'opencode-zen' },
        { id: 'deepseek-v4-flash', provider: 'opencode-zen', providerId: 'opencode-zen' },
      ],
    },
  ]);
});

test('a providerId alone still forms a titled group', () => {
  const sections = groupByProvider([{ id: 'qwen/qwen3.8-27b-free', providerId: 'orcarouter' }]);
  expect(sections).toEqual([
    { key: 'orcarouter', title: 'orcarouter', data: [{ id: 'qwen/qwen3.8-27b-free', providerId: 'orcarouter' }] },
  ]);
});

test('models without provider identity share one explicit Other group', () => {
  const orphanA = { id: 'legacy-model-a' };
  const orphanB = { id: 'legacy-model-b' };
  const sections = groupByProvider([orphanA, orphanB]);
  expect(sections).toEqual([{ key: OTHER_GROUP_KEY, title: 'Other', data: [orphanA, orphanB] }]);
});

test('sections sort alphabetically by title; entries keep arrival order inside a group', () => {
  const sections = groupByProvider([
    { id: 'kilo/later', provider: 'KiloCode', providerId: 'kilo' },
    { id: 'anthropic/claude', provider: 'Anthropic', providerId: 'anthropic' },
    { id: 'kilo/earlier', provider: 'KiloCode', providerId: 'kilo' },
    { id: 'mystery', providerId: 'zeta-labs' },
  ]);
  expect(sections.map((section) => [section.title, section.data.map((m) => m.id)])).toEqual([
    ['Anthropic', ['anthropic/claude']],
    ['KiloCode', ['kilo/later', 'kilo/earlier']],
    ['zeta-labs', ['mystery']],
  ]);
});

test('an empty catalog yields no sections', () => {
  expect(groupByProvider([])).toEqual([]);
});
