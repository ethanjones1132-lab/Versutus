import { GATEWAY_COMMANDS, type GatewayCommandDanger } from '@/lib/gateway/dashboard';
import type { GatewayCapabilityCommand } from '@/lib/portal/manifest';

export type ConfirmableSlash = {
  slash: string;
  label: string;
  danger: GatewayCommandDanger;
};

const LOCAL_RESERVED = ['/help', '/model', '/model set', '/model agent', '/model routing', '/rpc'];

/**
 * Local write/destructive verbs no registry or capability entry advertises:
 * `/workflow`'s management half is dispatched entirely on this device
 * (runWorkflowManagement), so GATEWAY_COMMANDS and dynamicCommands never
 * carry its danger — without this table the confirmation sheet can never
 * fire for them. `needsArg` marks a verb that is only that verb when a
 * workflow name follows: the dispatcher enters management on
 * `verb<whitespace>` only, so `/workflow delete` alone is a run of a
 * workflow named "delete", not a removal.
 */
const LOCAL_DANGER_SLASHES: ReadonlyArray<{
  prefix: string;
  label: string;
  danger: GatewayCommandDanger;
  needsArg?: boolean;
}> = [
  { prefix: '/workflow delete', label: 'Remove workflow', danger: 'destructive', needsArg: true },
  { prefix: '/workflow rename', label: 'Rename workflow', danger: 'write', needsArg: true },
  { prefix: '/workflow new', label: 'Save workflow', danger: 'write', needsArg: true },
];

export function findConfirmableSlash(
  input: string,
  dynamicCommands: GatewayCapabilityCommand[] = [],
): ConfirmableSlash | undefined {
  const tokens = input.trim().toLowerCase().split(/\s+/);
  for (let depth = tokens.length; depth >= 1; depth -= 1) {
    const prefix = tokens.slice(0, depth).join(' ');
    // Local rules win over built-in and dynamic claims, the same precedence
    // LOCAL_RESERVED already gets — a capability must not re-label them.
    const localDanger = LOCAL_DANGER_SLASHES.find(
      (rule) => rule.prefix === prefix && (!rule.needsArg || depth < tokens.length),
    );
    if (localDanger) {
      return { slash: localDanger.prefix, label: localDanger.label, danger: localDanger.danger };
    }
    if (LOCAL_RESERVED.includes(prefix)) {
      return { slash: prefix, label: prefix, danger: 'safe' };
    }
    const builtIn = GATEWAY_COMMANDS.find((command) => {
      const slashes = [command.slash, ...(command.aliases ?? [])]
        .filter(Boolean)
        .map((item) => item!.toLowerCase());
      return slashes.includes(prefix);
    });
    if (builtIn) {
      return {
        slash: builtIn.slash ?? prefix,
        label: builtIn.label,
        danger: builtIn.danger,
      };
    }
    const dynamic = dynamicCommands.find((command) => command.slash.toLowerCase() === prefix);
    if (dynamic) {
      return {
        slash: dynamic.slash,
        label: dynamic.slash,
        danger: dynamic.danger,
      };
    }
  }
  return undefined;
}
