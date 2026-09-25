/**
 * Chat header layout rules.
 *
 * The header is ONE row — back · title with the model as its tappable
 * subtitle · one menu (docs/visual-direction-2026-09.md). There are no chips
 * left to place and nothing ever wraps to a second row, so the only
 * width-sensitive decision left is which line the subtitle draws: the model
 * when this thread can pick one, the gateway line when it cannot.
 */

/** Headline: a group is the room name; a thread is the backend, else the gateway. */
export function chatHeaderTitle(input: {
  gatewayName: string;
  backendLabel?: string;
  groupName?: string;
}): string {
  const groupName = input.groupName?.trim();
  if (groupName) return groupName;
  return input.backendLabel ?? input.gatewayName;
}

/**
 * Subtitle line under the title: the model when this thread offers a model
 * press (that is what the row is tappable for), else the gateway attribution,
 * else the connection detail.
 */
export function chatHeaderSubtitle(input: {
  gatewayName: string;
  /** Model name for this thread, when the thread has one. */
  modelLabel?: string;
  /** True only when a tap can open the model picker — the subtitle is the model then. */
  modelPress: boolean;
  backendLabel?: string;
  groupName?: string;
  statusDetail?: string;
}): string {
  if (input.modelLabel && input.modelPress) return input.modelLabel;
  if (input.backendLabel || input.groupName?.trim()) {
    return `via ${input.gatewayName}${input.statusDetail ? ` · ${input.statusDetail}` : ''}`;
  }
  return input.statusDetail || 'Ready for chat and slash commands';
}
