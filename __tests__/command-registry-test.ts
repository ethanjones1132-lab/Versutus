import { GATEWAY_COMMANDS, type GatewayCommand } from '@/lib/gateway/dashboard';
import { getSlashCommandSuggestions, isSlashCommandInput } from '@/lib/gateway/slash-commands';

/**
 * Registry invariants for the slash-command surface.
 *
 * The command palette makes every one of these reachable in one tap, which
 * moves the cost of a malformed entry from "a power user who typed it hits an
 * error" to "anyone browsing the list hits it". These are the properties the
 * palette relies on when it renders and groups a command.
 */

const slashCommands = GATEWAY_COMMANDS.filter((command): command is GatewayCommand & { slash: string } =>
  Boolean(command.slash),
);

describe('gateway command registry', () => {
  test('the registry is non-trivial', () => {
    expect(GATEWAY_COMMANDS.length).toBeGreaterThan(20);
    expect(slashCommands.length).toBeGreaterThan(20);
  });

  test('every command has an id, label and group', () => {
    const broken = GATEWAY_COMMANDS.filter(
      (command) => !command.id?.trim() || !command.label?.trim() || !command.group?.trim(),
    );
    expect(broken.map((command) => command.id ?? '(no id)')).toEqual([]);
  });

  test('command ids are unique', () => {
    const seen = new Map<string, number>();
    for (const command of GATEWAY_COMMANDS) {
      seen.set(command.id, (seen.get(command.id) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
    expect(duplicates).toEqual([]);
  });

  test('slash strings are unique — a duplicate would shadow a command silently', () => {
    const seen = new Map<string, string[]>();
    for (const command of slashCommands) {
      seen.set(command.slash, [...(seen.get(command.slash) ?? []), command.id]);
    }
    const duplicates = [...seen.entries()].filter(([, ids]) => ids.length > 1);
    expect(duplicates).toEqual([]);
  });

  test('every slash starts with / and is cleanly tokenized', () => {
    // Sub-command slashes such as `/session list` are legitimate — the matcher
    // walks the longest token prefix first. What breaks tokenization is leading
    // or trailing space, or a double space inside.
    const malformed = slashCommands.filter(
      (command) =>
        !command.slash.startsWith('/') ||
        command.slash !== command.slash.trim() ||
        /\s{2,}/.test(command.slash),
    );
    expect(malformed.map((command) => command.slash)).toEqual([]);
  });

  test('danger is one of the three legal values', () => {
    const legal = new Set(['safe', 'write', 'destructive']);
    const illegal = GATEWAY_COMMANDS.filter((command) => !legal.has(command.danger));
    expect(illegal.map((command) => `${command.id}=${command.danger}`)).toEqual([]);
  });

  test('transport is rpc or agent, and carries the field that transport needs', () => {
    const illegalTransport = GATEWAY_COMMANDS.filter(
      (command) => command.transport !== 'rpc' && command.transport !== 'agent',
    );
    expect(illegalTransport.map((command) => command.id)).toEqual([]);

    // An rpc command with no method cannot be routed; an agent command with no
    // agentCommand cannot be dispatched. Either is a dead entry in the palette.
    const unroutable = GATEWAY_COMMANDS.filter((command) =>
      command.transport === 'rpc' ? !command.method : !command.agentCommand,
    );
    expect(unroutable.map((command) => `${command.id}/${command.transport}`)).toEqual([]);
  });

  test('every browsable command has a description for the palette to render', () => {
    const undescribed = slashCommands.filter(
      (command) => !command.description?.trim() && !command.label?.trim(),
    );
    expect(undescribed.map((command) => command.slash)).toEqual([]);
  });

  test('aliases do not collide with another command’s slash', () => {
    const slashes = new Set(slashCommands.map((command) => command.slash));
    const collisions: string[] = [];
    for (const command of GATEWAY_COMMANDS) {
      for (const alias of command.aliases ?? []) {
        const normalized = alias.startsWith('/') ? alias : `/${alias}`;
        if (normalized !== command.slash && slashes.has(normalized)) {
          collisions.push(`${command.id}:${normalized}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });
});

describe('isSlashCommandInput', () => {
  test.each([
    ['/health', true],
    ['   /health', true],
    ['health', false],
    ['', false],
    ['not /health', false],
  ])('%s → %s', (input, expected) => {
    expect(isSlashCommandInput(input as string)).toBe(expected);
  });
});

describe('getSlashCommandSuggestions surface guarantees', () => {
  test('every suggestion the palette can render is well formed', () => {
    const all = getSlashCommandSuggestions('', null, [], {}, [], Number.POSITIVE_INFINITY);

    for (const item of all) {
      expect(item.value.startsWith('/')).toBe(true);
      expect(item.label.length).toBeGreaterThan(0);
      expect(typeof item.description).toBe('string');
      expect(item.family.length).toBeGreaterThan(0);
      expect(typeof item.unavailable).toBe('boolean');
    }
  });

  test('values are unique across the whole surface', () => {
    const all = getSlashCommandSuggestions('', null, [], {}, [], Number.POSITIVE_INFINITY);
    const values = all.map((item) => item.value);
    expect(values.length).toBe(new Set(values).size);
  });

  test('/rpc is hidden until it is typed', () => {
    const idle = getSlashCommandSuggestions('', null, [], {}, [], Number.POSITIVE_INFINITY);
    expect(idle.some((item) => item.value.startsWith('/rpc'))).toBe(false);

    const typed = getSlashCommandSuggestions('/rpc', null, [], {}, [], Number.POSITIVE_INFINITY);
    expect(typed.some((item) => item.value.startsWith('/rpc'))).toBe(true);
  });

  test('the limit argument is respected', () => {
    expect(getSlashCommandSuggestions('', null, [], {}, [], 3)).toHaveLength(3);
    expect(getSlashCommandSuggestions('', null, [], {}, [], 1)).toHaveLength(1);
  });

  test('available commands sort ahead of unavailable ones', () => {
    const methods = Object.fromEntries(
      GATEWAY_COMMANDS.slice(0, 5).map((command) => [command.id, { available: false }]),
    );
    const all = getSlashCommandSuggestions('', null, [], methods, [], Number.POSITIVE_INFINITY);
    const firstUnavailable = all.findIndex((item) => item.unavailable);
    const lastAvailable = all.map((item) => item.unavailable).lastIndexOf(false);

    if (firstUnavailable !== -1) {
      expect(firstUnavailable).toBeGreaterThan(lastAvailable - 1);
    }
  });
});
