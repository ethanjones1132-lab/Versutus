import type { TextFieldProps } from './types';

/**
 * Pure decision helpers for the SwiftUI-backed kit TextField
 * (`TextField.ios.tsx`). They translate the shared cross-platform prop type
 * onto the modifiers and views the installed @expo/ui SDK 57 actually ships,
 * and they live here — with zero @expo/ui imports — so jest can pin every
 * translation without touching a native binding. The .ios.tsx component owns
 * no keyboard decisions of its own; it only renders what these helpers pick.
 */

/** SwiftUI's `.textInputAutocapitalization(_:)` vocabulary. */
export type IosAutocapitalization = 'never' | 'words' | 'sentences' | 'characters';

const AUTOCAPITALIZATION: Record<
  NonNullable<TextFieldProps['autoCapitalize']>,
  IosAutocapitalization
> = {
  none: 'never',
  sentences: 'sentences',
  words: 'words',
  characters: 'characters',
};

/**
 * Maps React Native's autoCapitalize onto SwiftUI's autocapitalization.
 * The kit defaults to 'none' on both platforms (secret-bearing config fields
 * are the majority case here), so an omitted prop pins 'never'.
 */
export function autocapitalizationFor(
  autoCapitalize?: TextFieldProps['autoCapitalize'],
): IosAutocapitalization {
  return AUTOCAPITALIZATION[autoCapitalize ?? 'none'];
}

/**
 * Maps RN's autoCorrect onto `.autocorrectionDisabled(_:)`. The kit defaults
 * to off (token/session-key fields must not be "corrected"), so an omitted
 * prop disables correction.
 */
export function autocorrectionDisabledFor(autoCorrect?: boolean): boolean {
  return !(autoCorrect ?? false);
}

/**
 * Maps RN's returnKeyType onto SwiftUI's `.submitLabel(_:)`. Every value in
 * the shared union has an exact SwiftUI counterpart; callers only reach this
 * when a returnKeyType was provided, so an omitted prop leaves the modifier
 * off and iOS keeps its context-sensitive default label.
 */
export function submitLabelFor(
  returnKeyType: NonNullable<TextFieldProps['returnKeyType']>,
): NonNullable<TextFieldProps['returnKeyType']> {
  return returnKeyType;
}

/**
 * Picks the field view: `secureTextEntry` renders SwiftUI's SecureField,
 * which has no multiline axis. Secure wins over multiline — the same rule
 * React Native enforces by forbidding the combination outright.
 */
export function usesSecureField(secureTextEntry?: boolean): boolean {
  return Boolean(secureTextEntry);
}
