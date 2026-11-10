import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  botHasHermesFeatures,
  botProfileFeatures,
  botRowSubtitle,
  botRuntimeFamily,
  botRuntimeLabel,
  botRuntimeWritable,
  type PublicBot,
  type RosterRow,
} from '@/lib/gateway/bots';
import { botRuntimes, runtimeForBot } from '@/lib/gateway/bot-runtimes';
import { filterRosterBots, rosterBackendFilters } from '@/lib/gateway/roster-filter';
import type { GatewayBackend } from '@/lib/portal/manifest';

// VS-093 slice 2: the Gate serves fixed Claude Code and Codex Bots beside the
// Hermes and OpenCode ones. They chat like any Bot but carry none of a Hermes
// profile's tree (no listen key, memory, skills or routines) and cannot be
// created or edited from the phone. This repo has jest-expo but no renderer,
// so the pure decisions are asserted here and the component wiring on source.
const SHEET = readFileSync(
  join(__dirname, '..', 'src', 'components', 'chat', 'bot-detail-sheet.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');
const SCREEN = readFileSync(
  join(__dirname, '..', 'src', 'components', 'chat', 'chat-screen.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

const HERMES: GatewayBackend = {
  id: 'hermes-local',
  label: 'Hermes',
  kind: 'environment',
  adapterId: 'hermes',
  capabilities: ['chat', 'bots'],
};
const OPENCODE: GatewayBackend = {
  id: 'opencode-local',
  label: 'OpenCode',
  kind: 'environment',
  adapterId: 'opencode',
  capabilities: ['sessions', 'bots'],
};
// The fixed runtimes answer `bots` so their Bots can be listed and chatted
// with, but neither can create one — the exact shape the New Agent sheet must
// never offer.
const CLAUDE: GatewayBackend = {
  id: 'claude-code-local',
  label: 'Claude Code',
  kind: 'environment',
  adapterId: 'claude-code',
  capabilities: ['chat', 'sessions', 'bots'],
};
const CODEX: GatewayBackend = {
  id: 'codex-local',
  label: 'Codex',
  kind: 'environment',
  adapterId: 'codex',
  capabilities: ['chat', 'sessions', 'bots'],
};

function bot(id: string, runtime?: string): PublicBot {
  return { id, displayName: id, routable: true, runtime };
}

describe('the roster names the CLI runtimes', () => {
  test('Claude Code and Codex get their own labels', () => {
    expect(botRuntimeLabel('claude-code')).toBe('Claude Code');
    // The Gate may report the adapter id or the bare family; both name it.
    expect(botRuntimeLabel('claude')).toBe('Claude Code');
    expect(botRuntimeLabel('codex')).toBe('Codex');
    expect(botRuntimeLabel('  Codex  ')).toBe('Codex');
  });

  test('Hermes stays unlabelled and OpenCode reads as it always did', () => {
    expect(botRuntimeLabel(undefined)).toBe('');
    expect(botRuntimeLabel(null)).toBe('');
    expect(botRuntimeLabel('hermes')).toBe('');
    expect(botRuntimeLabel('opencode')).toBe('OpenCode');
  });

  test('a tagged Bot carries its runtime in the row subtitle', () => {
    expect(botRowSubtitle(bot('reviewer', 'claude-code'))).toBe('Claude Code Bot');
    expect(botRowSubtitle({ ...bot('triage', 'codex'), model: { default: 'gpt-5', provider: null } }))
      .toBe('Codex Bot · gpt-5');
    // Absent runtime is Hermes, which earns no tag — unchanged from before.
    expect(botRowSubtitle(bot('scout'))).toBe('Bot');
  });

  test('a runtime id is folded into one family', () => {
    expect(botRuntimeFamily(undefined)).toBe('hermes');
    expect(botRuntimeFamily('hermes-main')).toBe('hermes');
    expect(botRuntimeFamily('opencode')).toBe('opencode');
    expect(botRuntimeFamily('claude-code')).toBe('claude-code');
    expect(botRuntimeFamily('codex-cli')).toBe('codex');
    expect(botRuntimeFamily('zeta')).toBe('other');
  });
});

describe('the roster filter chips', () => {
  test('are ordered Hermes, OpenCode, Claude Code, Codex', () => {
    // Deliberately shuffled input: the picker owns the order, not the roster.
    expect(rosterBackendFilters([
      bot('c', 'codex'),
      bot('o', 'opencode'),
      bot('cl', 'claude-code'),
      bot('h', 'hermes'),
    ])).toEqual([
      { id: 'hermes', label: 'Hermes' },
      { id: 'opencode', label: 'OpenCode' },
      { id: 'claude-code', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
    ]);
  });

  test('an unknown runtime still sorts alphabetically after the known four', () => {
    expect(rosterBackendFilters([bot('z', 'Zeta'), bot('x', 'codex'), bot('a', 'Alpha'), bot('h', 'hermes')]))
      .toEqual([
        { id: 'hermes', label: 'Hermes' },
        { id: 'codex', label: 'Codex' },
        { id: 'alpha', label: 'Alpha' },
        { id: 'zeta', label: 'Zeta' },
      ]);
  });

  test('filtering a CLI Bot keeps navigation rows and drops the others', () => {
    const rows: RosterRow[] = [
      { kind: 'configurable' },
      { kind: 'bot', bot: bot('h', 'hermes') },
      { kind: 'bot', bot: bot('cl', 'claude-code') },
      { kind: 'bot', bot: bot('cx', 'codex') },
    ];
    expect(filterRosterBots(rows, 'claude-code')).toEqual([rows[0], rows[2]]);
    expect(filterRosterBots(rows, 'codex')).toEqual([rows[0], rows[3]]);
  });
});

describe('the New Agent sheet never offers a fixed runtime', () => {
  test('Claude Code and Codex are excluded even though they advertise bots', () => {
    const runtimes = botRuntimes([CLAUDE, CODEX, OPENCODE, HERMES], []);
    expect(runtimes.map((runtime) => runtime.id)).toEqual(['hermes-local', 'opencode-local']);
    expect(runtimes.map((runtime) => runtime.label)).toEqual(['Hermes', 'OpenCode']);
  });

  test('a backend without the bots capability was never capable in the first place', () => {
    const codexWithoutBots: GatewayBackend = { ...CODEX, capabilities: ['chat', 'sessions'] };
    expect(botRuntimes([codexWithoutBots, HERMES], []).map((runtime) => runtime.id))
      .toEqual(['hermes-local']);
  });

  test('editing a fixed Bot finds no runtime to aim at', () => {
    const runtimes = botRuntimes([CLAUDE, CODEX, HERMES, OPENCODE], []);
    expect(runtimeForBot(runtimes, { backendId: 'claude-code-local' })).toEqual([]);
    expect(runtimeForBot(runtimes, { backendId: 'codex-local' })).toEqual([]);
    expect(runtimeForBot(runtimes, { backendId: 'hermes-local' }).map((runtime) => runtime.id))
      .toEqual(['hermes-local']);
  });
});

describe('Hermes-profile features are decided by the runtime', () => {
  test('a Hermes Bot — runtime absent or hermes — carries every feature', () => {
    for (const runtime of [undefined, null, '', 'hermes', 'hermes-local']) {
      const features = botProfileFeatures(runtime);
      expect(features).toEqual({ listenKey: true, memory: true, skills: true, routines: true });
      expect(botHasHermesFeatures(runtime)).toBe(true);
    }
  });

  test('every other runtime gets the honest reduced surface', () => {
    for (const runtime of ['opencode', 'claude-code', 'codex', 'some-future-cli']) {
      expect(botProfileFeatures(runtime)).toEqual({
        listenKey: false,
        memory: false,
        skills: false,
        routines: false,
      });
      expect(botHasHermesFeatures(runtime)).toBe(false);
    }
  });

  test('only Claude Code and Codex Bots are uneditable from the phone', () => {
    expect(botRuntimeWritable(undefined)).toBe(true);
    expect(botRuntimeWritable('hermes')).toBe(true);
    expect(botRuntimeWritable('opencode')).toBe(true);
    expect(botRuntimeWritable('claude-code')).toBe(false);
    expect(botRuntimeWritable('codex')).toBe(false);
  });
});

describe('the components ask the rule instead of naming one runtime', () => {
  test('the detail sheet hides memory and Edit for a Bot without a profile tree', () => {
    expect(SHEET).toContain('const features = botProfileFeatures(shown.runtime);');
    expect(SHEET).toContain('{features.memory ? <BotMemoryPane botId={shown.id} /> : null}');
    expect(SHEET).toContain('const writable = botRuntimeWritable(shown.runtime);');
    expect(SHEET).toContain('{onEdit && detail.editable && writable ? (');
  });

  test('the Bot panel hides skills and routines and reads neither', () => {
    expect(SCREEN).toContain('const activeBotFeatures = botProfileFeatures(activeBotRow?.runtime);');
    expect(SCREEN).toContain('{activeBotFeatures.skills ? (');
    expect(SCREEN).toContain('{activeBotFeatures.routines ? (');
    // Hiding the panes is not enough: the reads behind them must not run
    // either, or a reduced Bot still costs a refused round-trip per open.
    expect(SCREEN).toContain('!activeBotFeatures.skills || status !== \'connected\'');
    expect(SCREEN).toContain('!activeBotFeatures.routines || status !== \'connected\'');
  });

  test('both Edit entry points refuse a fixed Bot', () => {
    expect(SCREEN).toContain('botRuntimeWritable(activeBotRow?.runtime)');
  });
});
