import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildBotUpdatePatch, botToEditInput } from '@/lib/gateway/bots';
import { filterModels, groupByProvider, modelPickerName } from '@/lib/gateway/model-selection';

// The bot edit form pinned a model by hand-typed `provider/model-id`, with no
// catalogue and no validation, so a typo pinned something that did not exist
// and only failed later mid-turn. It now picks from the catalogue the chat
// screen already holds. This repo has jest-expo but no renderer, so the wiring
// is asserted on the source and the pick logic on the exported helpers.
const SHEET = readFileSync(
  join(__dirname, '..', 'src', 'components', 'chat', 'new-agent-sheet.tsx'),
  'utf8',
);
const SCREEN = readFileSync(
  join(__dirname, '..', 'src', 'components', 'chat', 'chat-screen.tsx'),
  'utf8',
);

const CATALOG = [
  { id: 'opencode-zen/laguna-s-2.1-free', providerId: 'opencode-zen', provider: 'OpenCode Zen', modelId: 'laguna-s-2.1-free', available: true },
  { id: 'opencode-zen/nemotron-3-ultra-free', providerId: 'opencode-zen', provider: 'OpenCode Zen', modelId: 'nemotron-3-ultra-free', available: true },
  { id: 'xai-oauth/grok-4.6', providerId: 'xai-oauth', provider: 'xAI', modelId: 'grok-4.6', available: false },
];

describe('the bot edit form pins a model from the catalogue', () => {
  test('the sheet accepts a catalogue and the chat screen supplies the one it already has', () => {
    expect(SHEET).toContain('models?: BotModelOption[]');
    // Scope to the NewAgentSheet element: the screen renders more than one
    // sheet that takes `models`, so a bare file-wide search cannot tell which
    // one got the catalogue and passes even when this sheet is left without.
    const open = SCREEN.indexOf('<NewAgentSheet');
    expect(open).toBeGreaterThan(-1);
    const element = SCREEN.slice(open, SCREEN.indexOf('/>', open));
    expect(element).toContain('models={modelRows}');
  });

  test('a reachable catalogue replaces the hand-typed model field', () => {
    expect(SHEET).toContain('models.length > 0');
    expect(SHEET).toContain('Pin model ');
  });

  test('an unreachable catalogue keeps the manual path rather than losing the capability', () => {
    expect(SHEET).toContain('placeholder="provider/model-id"');
    expect(SHEET).toContain('placeholder="provider-id"');
  });

  test('an unavailable model is not selectable', () => {
    expect(SHEET).toContain("disabled={item.available === false}");
  });

  test('the picker does not nest a ScrollView inside the sheet ScrollView', () => {
    // The sheet's own ScrollView is what keeps Save reachable on a short phone
    // (new-agent-sheet-scroll-test). A vertical scroller inside it fights for
    // the gesture on Android, so the rows are capped and rendered inline.
    expect((SHEET.match(/<ScrollView/g) ?? []).length).toBe(1);
    expect(SHEET).toContain('MODEL_ROW_CAP');
  });

  test('a catalogue larger than the cap says how many are hidden', () => {
    expect(SHEET).toContain('hiddenModelCount');
    expect(SHEET).toContain('search to narrow the list');
  });
});

describe('the pick resolves to the fields the Gate PATCH expects', () => {
  test('a catalogue row yields the bare model id and its provider, not the joined slug', () => {
    // The Gate writes `model.default` and the provider separately
    // (backends/hermes.mjs updateBot), so the joined `providerId/modelId` id
    // must not be pinned whole.
    const row = CATALOG[0];
    expect(row.modelId).toBe('laguna-s-2.1-free');
    expect(row.providerId).toBe('opencode-zen');
    expect(modelPickerName(row)).toBe('laguna-s-2.1-free');
  });

  test('the catalogue groups and filters with the same helpers the chat picker uses', () => {
    expect(groupByProvider(CATALOG)).toHaveLength(2);
    expect(filterModels(CATALOG, 'grok')).toHaveLength(1);
  });

  test('a round trip through the edit prefill keeps the pin', () => {
    const draft = botToEditInput({
      id: 'anvil', displayName: 'anvil', routable: true, routingIssue: null,
      description: 'x', model: { default: 'grok-4.6', provider: 'xai-oauth' },
    } as never);
    expect(draft.modelId).toBe('grok-4.6');
    expect(draft.providerId).toBe('xai-oauth');
    expect(buildBotUpdatePatch(draft)).toMatchObject({ modelId: 'grok-4.6', providerId: 'xai-oauth' });
  });

  test('an explicit null clears both pins while omitted fields remain no-ops', () => {
    expect(buildBotUpdatePatch({ modelId: null, providerId: null })).toEqual({ modelId: null, providerId: null });
    expect(buildBotUpdatePatch({})).toEqual({});
  });

  test('editing emits null when both model fields are blank', () => {
    expect(SHEET).toContain('editing ? modelId.trim() || null : modelId.trim() || undefined');
    expect(SHEET).toContain('editing ? providerId.trim() || null : providerId.trim() || undefined');
  });
});
