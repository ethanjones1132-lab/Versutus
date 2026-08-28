export type ActivityKeyboardBehavior = 'padding' | undefined;

/**
 * Activity run-prompt field mirrors chat composer + terminal: iOS lifts via
 * KeyboardAvoidingView `padding`, Android relies on ComposerKeyboardLift
 * (useAnimatedKeyboard) and bypasses KAV entirely.
 */
export function activityKeyboardBehavior(platform: string): ActivityKeyboardBehavior {
  return platform === 'ios' ? 'padding' : undefined;
}

export function isActivityKavEnabled(platform: string): boolean {
  return activityKeyboardBehavior(platform) !== undefined;
}
