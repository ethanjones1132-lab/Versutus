import { GATEWAY_COMMANDS, type GatewayCommandDanger } from '@/lib/gateway/dashboard';
import type { GatewayCapabilityCommand } from '@/lib/portal/manifest';

export type ConfirmableSlash = {
  slash: string;
  label: string;
  danger: GatewayCommandDanger;
};

const LOCAL_RESERVED = ['/help', '/model', '/model set', '/model agent', '/model routing', '/rpc'];

export function findConfirmableSlash(
  input: string,
  dynamicCommands: GatewayCapabilityCommand[] = [],
): ConfirmableSlash | undefined {
  const tokens = input.trim().toLowerCase().split(/\s+/);
  for (let depth = tokens.length; depth >= 1; depth -= 1) {
    const prefix = tokens.slice(0, depth).join(' ');
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
