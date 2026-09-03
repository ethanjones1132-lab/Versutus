import type { GatewayCommand } from '@/lib/gateway/dashboard';

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The caption for a Quick-commands panel button. The panel received entries
 * that already carry the call they will make — the registry builds each one
 * with a method and a slash — but rendered label-only buttons, so an
 * operator tapping "Session usage" could not tell it will call
 * `session.usage` until the output sheet said so. The caption names that
 * call from the entry's own fields; nothing is fetched and nothing is
 * guessed.
 */
export function commandPanelCaption(command: GatewayCommand): string | undefined {
  return clean(command.method) ?? clean(command.slash);
}

/**
 * Whether the button carries a caption beyond its label. False when the
 * entry names no call — the caller keeps today's label-only button.
 */
export function commandPanelHasCaption(command: GatewayCommand): boolean {
  return commandPanelCaption(command) !== undefined;
}
