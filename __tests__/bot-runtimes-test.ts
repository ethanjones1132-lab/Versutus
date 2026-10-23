import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { botRowSubtitle, botRuntimeLabel, type PublicBot } from '@/lib/gateway/bots';
import { botRuntimes, runtimeForBot } from '@/lib/gateway/bot-runtimes';
import type { GatewayBackend } from '@/lib/portal/manifest';

// ADR 0016: a Bot can live on OpenCode as well as Hermes. The sheet offers the
// choice, the OpenCode side lists only the models the Gate flagged free, and a
// create is aimed at the chosen environment. This repo has jest-expo but no
// renderer, so the sheet wiring is asserted on the source and the logic on the
// exported helpers.
const SHEET = readFileSync(
  join(__dirname, '..', 'src', 'components', 'chat', 'new-agent-sheet.tsx'),
  'utf8',
);
const SCREEN = readFileSync(
  join(__dirname, '..', 'src', 'components', 'chat', 'chat-screen.tsx'),
  'utf8',
);

const HERMES: GatewayBackend = {
  id: 'hermes-local', label: 'Hermes', kind: 'environment', adapterId: 'hermes', capabilities: ['chat', 'bots'],
};
const OPENCODE: GatewayBackend = {
  id: 'opencode-local', label: 'OpenCode', kind: 'environment', adapterId: 'opencode', capabilities: ['sessions', 'bots'],
};
const CODEX: GatewayBackend = {
  id: 'codex-local', label: 'Codex', kind: 'environment', adapterId: 'codex', capabilities: ['sessions'],
};

const CATALOG = [
  { id: 'opencode/mimo-v2.6-flash-free', provider: 'OpenCode Zen', providerId: 'opencode', modelId: 'mimo-v2.6-flash-free', backendId: 'opencode-local', free: true },
  { id: 'opencode/gpt-paid', provider: 'OpenCode Zen', providerId: 'opencode', modelId: 'gpt-paid', backendId: 'opencode-local', free: false },
  { id: 'opencode/unflagged', providerId: 'opencode', modelId: 'unflagged', backendId: 'opencode-local' },
  { id: 'hermes/grok', providerId: 'xai', modelId: 'grok', backendId: 'hermes-local' },
];

describe('which runtimes can host a Bot', () => {
  test('only environments that advertise bots are offered, Hermes first', () => {
    const runtimes = botRuntimes([OPENCODE, CODEX, HERMES], CATALOG);
    expect(runtimes.map((runtime) => runtime.id)).toEqual(['hermes-local', 'opencode-local']);
    expect(runtimes.map((runtime) => runtime.label)).toEqual(['Hermes', 'OpenCode']);
  });

  test('a Gate with one Bot runtime offers no choice', () => {
    expect(botRuntimes([HERMES, CODEX], CATALOG)).toHaveLength(1);
    expect(botRuntimes(undefined, undefined)).toEqual([]);
  });

  test('Hermes keeps the chat screen\'s own catalogue; OpenCode is free-only with its own list', () => {
    const [hermes, opencode] = botRuntimes([HERMES, OPENCODE], CATALOG);
    expect(hermes.freeOnly).toBe(false);
    expect(hermes.models).toBeUndefined();
    expect(opencode.freeOnly).toBe(true);
    // Only the rows the Gate flagged free: not paid, and not unflagged either —
    // an older Gate that says nothing must not make every model look free.
    expect(opencode.models?.map((model) => model.modelId)).toEqual(['mimo-v2.6-flash-free']);
  });

  test('an OpenCode with no free models lists none rather than falling back to all', () => {
    const [opencode] = botRuntimes([OPENCODE], CATALOG.filter((row) => row.free !== true));
    expect(opencode.models).toEqual([]);
  });

  test('editing is aimed at the runtime the Bot already lives on', () => {
    const runtimes = botRuntimes([HERMES, OPENCODE], CATALOG);
    expect(runtimeForBot(runtimes, { backendId: 'opencode-local' }).map((runtime) => runtime.id)).toEqual(['opencode-local']);
    expect(runtimeForBot(runtimes, {})).toEqual([]);
  });
});

describe('the roster says where a Bot lives', () => {
  const base: PublicBot = { id: 'scout', displayName: 'scout', routable: true };

  test('a Hermes Bot reads as it always did', () => {
    expect(botRowSubtitle(base)).toBe('Bot');
    expect(botRowSubtitle({ ...base, runtime: 'hermes', model: { default: 'grok', provider: 'xai' } })).toBe('Bot · grok');
  });

  test('an OpenCode Bot is tagged, with its pin', () => {
    expect(botRowSubtitle({ ...base, runtime: 'opencode', model: { default: 'mimo-v2.6-flash-free', provider: 'opencode' } }))
      .toBe('OpenCode Bot · mimo-v2.6-flash-free');
    expect(botRuntimeLabel('opencode')).toBe('OpenCode');
    expect(botRuntimeLabel(null)).toBe('');
  });
});

describe('the New Agent sheet', () => {
  test('offers a Runs-on choice only when there is something to choose, and only on create', () => {
    expect(SHEET).toContain('runtimes?: BotRuntimeOption[]');
    expect(SHEET).toContain('const chooseRuntime = !editing && runtimes.length > 1;');
  });

  test('a free-only runtime has no key inheritance and says only free models can be pinned', () => {
    expect(SHEET).toContain('{!editing && !freeOnly ? (');
    expect(SHEET).toContain('Only free models can be pinned.');
    expect(SHEET).toContain('inheritKeys: freeOnly ? false : inheritKeys,');
  });

  test('switching runtime drops a pin that belongs to the other one', () => {
    const at = SHEET.indexOf('setRuntimeId(runtime.id);');
    expect(at).toBeGreaterThan(-1);
    const handler = SHEET.slice(at, at + 200);
    expect(handler).toContain("setModelId('')");
    expect(handler).toContain("setProviderId('')");
  });

  test('a create names the runtime it is aimed at', () => {
    expect(SHEET).toContain('backendId: activeRuntime.id');
  });

  test('the chat screen builds the runtimes from the unscoped catalogue and aims an edit at the owner', () => {
    expect(SCREEN).toContain('botRuntimes(backends, modelCatalog as Record<string, unknown>[])');
    const open = SCREEN.indexOf('<NewAgentSheet');
    const element = SCREEN.slice(open, SCREEN.indexOf('/>', open));
    expect(element).toContain('runtimes={editingBot ? runtimeForBot(botRuntimeOptions, editingBot) : botRuntimeOptions}');
  });
});
