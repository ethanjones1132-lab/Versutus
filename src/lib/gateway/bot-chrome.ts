/**
 * Bot Chat gathers skills, tools, and routines into the Bot's own panel
 * (opened from its name in the header) so the thread starts with the
 * conversation. Configurable chat still shows Tools alone.
 */

export function botChromeCombined(surface: { kind: string }): surface is { kind: 'bot' } {
  return surface.kind === 'bot';
}
