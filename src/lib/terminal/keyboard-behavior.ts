export type TerminalKeyboardBehavior = 'padding' | undefined;

/**
 * Terminal shell input mirrors the chat composer: iOS lifts via
 * KeyboardAvoidingView `padding`, Android relies on ComposerKeyboardLift
 * (useAnimatedKeyboard) and bypasses KAV entirely.
 */
export function terminalKeyboardBehavior(platform: string): TerminalKeyboardBehavior {
  return platform === 'ios' ? 'padding' : undefined;
}

export function isTerminalKavEnabled(platform: string): boolean {
  return terminalKeyboardBehavior(platform) !== undefined;
}
