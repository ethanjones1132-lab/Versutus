// The composer strip and the browsable palette both render
// `getSlashCommandSuggestions`; the store's names fold in as their own family
// so `/workflow <name>` can be completed, not remembered. These cases pin the
// fold's rules: the plain prefix row, the per-workflow rows, the gating on a
// typed `/workflow`, and the byte-identical surface everything else keeps.
import {
  executeGatewaySlashCommand,
  getSlashCommandSuggestions,
} from '@/lib/gateway/slash-commands';
import type { SlashCommandSuggestion } from '@/lib/gateway/slash-commands';
import type { SavedWorkflow } from '@/lib/workflow/workflow-store';
import { GATEWAY_COMMANDS } from '@/lib/gateway/dashboard';

const workflows: SavedWorkflow[] = [
  {
    id: 'wf-1',
    name: 'Nightly docs',
    prompt: 'rebuild the docs site',
    createdAt: 1700000000000,
    runCount: 2,
  },
  {
    id: 'wf-2',
    name: 'inbox sweep',
    prompt: 'clear the inbox',
    botId: 'bot-3',
    createdAt: 1700000005000,
    runCount: 0,
  },
];

describe('workflow suggestions in getSlashCommandSuggestions', () => {
  it('typing /workflow surfaces the prefix row plus one row per saved workflow', () => {
    const rows = getSlashCommandSuggestions('/workflow', null, [], {}, [], 12, [], workflows);
    const values = rows.map((row) => row.value);
    expect(values).toContain('/workflow ');
    expect(values).toContain('/workflow Nightly docs');
    expect(values).toContain('/workflow inbox sweep');
  });

  it('/workflow names surface even a partially typed one and describe the prompt', () => {
    const rows = getSlashCommandSuggestions('/workflow night', null, [], {}, [], 12, [], workflows);
    expect(rows.map((row) => row.value)).toContain('/workflow Nightly docs');
    const row = rows.find((item) => item.workflowName === 'Nightly docs');
    expect(row?.description).toBe('rebuild the docs site');
    expect(row?.family).toBe('Workflows');
    expect(row?.unavailable).toBe(false);
    expect(row?.danger).toBe('local');
  });

  it('the Workflow family is absent from the idle palette entirely', () => {
    const idle = getSlashCommandSuggestions('/', null, [], {}, [], 12, [], workflows);
    expect(idle.some((row) => row.family === 'Workflows')).toBe(false);
    expect(idle.some((row) => row.workflowName !== undefined)).toBe(false);
  });

  it('an empty store still completes the plain prefix row', () => {
    const rows = getSlashCommandSuggestions('/workflow', null, [], {}, [], 12, [], []);
    expect(rows.map((row) => row.value)).toContain('/workflow ');
    expect(rows.every((row) => row.workflowName === undefined)).toBe(true);
  });

  it('an absent workflows argument behaves exactly like an empty store', () => {
    const without = getSlashCommandSuggestions('/workflow', null, [], {}, [], 12, []);
    const empty = getSlashCommandSuggestions('/workflow', null, [], {}, [], 12, [], []);
    expect(without.map((row) => row.value)).toEqual(empty.map((row) => row.value));
  });

  it('the /run, /model set, /session current and /help surface is byte-identical with rows folded in', () => {
    const withRows = getSlashCommandSuggestions('/run', null, [], {}, [], 12, [], workflows);
    const baseline = getSlashCommandSuggestions('/run', null, [], {}, [], 12, []);
    expect(withRows.filter((row) => row.family !== 'Workflows').map((row) => row.value))
      .toEqual(baseline.filter((row) => row.family !== 'Workflows').map((row) => row.value));
  });

  it('rows the composer strip can render stay well formed and deduped', () => {
    const folded = getSlashCommandSuggestions(
      '/w',
      null,
      [],
      {},
      [],
      Number.POSITIVE_INFINITY,
      [],
      workflows,
    );
    const seen = new Set<string>();
    const needle: SlashCommandSuggestion[] = folded.filter((row) => {
      if (seen.has(row.value)) return false;
      seen.add(row.value);
      return true;
    });
    for (const row of needle) {
      expect(row.value.startsWith('/')).toBe(true);
      expect(row.label.length).toBeGreaterThan(0);
      expect(typeof row.description).toBe('string');
      expect(row.family.length).toBeGreaterThan(0);
      expect(typeof row.unavailable).toBe('boolean');
    }
    const values = needle.map((row) => row.value);
    expect(values.length).toBe(new Set(values).size);
  });

  it('the limit argument still caps the folded rows under the older signatures', () => {
    expect(getSlashCommandSuggestions('/workflow', null, [], {}, [], 2, [], workflows)).toHaveLength(2);
  });

  it('every registry command row still behaves with a workflows argument passed positionally', () => {
    const all = getSlashCommandSuggestions('', null, [], {}, [], Number.POSITIVE_INFINITY, [], workflows);
    const registry = new Set(GATEWAY_COMMANDS.map((c) => c.slash).filter(Boolean));
    for (const row of all) {
      if (row.family !== 'Workflows' && row.family !== 'Recent') {
        expect(typeof row.value).toBe('string');
      }
    }
    expect(all.some((row) => row.value === '/help')).toBe(true);
    expect(registry.has('/run')).toBe(true);
  });

  it('/workflow reaches the executor unchanged by the machinery feeding this fold', async () => {
    const runTask = jest.fn().mockResolvedValue({
      runId: 'run-1',
      status: 'complete',
      approved: true,
      result: 'done',
    });
    const result = await executeGatewaySlashCommand('/workflow Inbox  Sweep', {
      hello: null,
      gatewayRequest: jest.fn(),
      runAgentCommand: jest.fn(),
      runTask,
      workflows: jest.fn().mockResolvedValue(workflows),
    });
    expect(runTask).toHaveBeenCalledWith('clear the inbox');
    expect(result.text).toContain('Run complete');
  });
});
