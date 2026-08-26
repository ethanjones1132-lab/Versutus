/**
 * Bot Chat collapses skills, tools, and routines behind one strip so the
 * thread starts higher. Configurable chat still shows Tools alone.
 */

export function botChromeCombined(surface: { kind: string }): surface is { kind: 'bot' } {
  return surface.kind === 'bot';
}

export function botChromeToggleLabel(open: boolean): string {
  return open ? 'Hide Bot' : 'Bot';
}
