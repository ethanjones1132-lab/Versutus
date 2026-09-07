import type { ReactNode } from 'react';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

export type ButtonSize = 'md' | 'sm';

export type TextVariant = 'display' | 'title' | 'headline' | 'body' | 'caption' | 'micro' | 'mono' | 'link';

export type TextColor =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'accent'
  | 'accentWarm'
  | 'inverse'
  | 'statusConnected'
  | 'statusConnecting'
  | 'statusDisconnected'
  | 'statusPairing';

export type GlassVariant = 'hero' | 'surface' | 'inset' | 'chip';

export type GlassSurfaceProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  interactive?: boolean;
  variant?: GlassVariant;
  radius?: number;
  padding?: number;
};

export type ButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  /**
   * Screen-reader hint that says what happens on tap. The `label` already
   * names the control ("Revoke"); the hint names the consequence ("Opens a
   * confirmation, then removes the token from the Gate") so a focus user
   * can decide whether to tap without missing the on-tap confirmation.
   * Pass only for destructive or otherwise surprising actions — a hint on
   * a reversible control is noise.
   */
  accessibilityHint?: string;
  /**
   * Screen-reader expanded state for a `Button` that toggles a collapsible
   * section. Passed through into `accessibilityState` only when defined, so
   * a plain action `Button` never newly announces `collapsed`.
   */
  expanded?: boolean;
  /**
   * Screen-reader busy state for a `Button` that runs async work behind a
   * swapped label (`'Send'` -> `'Round running…'`). Passed through into
   * `accessibilityState` only when defined, so a plain action `Button`
   * never newly announces `busy`.
   */
  busy?: boolean;
  /**
   * Screen-reader selected state for a `Button` that toggles between two
   * modes behind a swapped label (`'Inherit keys from default'` ->
   * `'Empty key set'`). Passed through into `accessibilityState` only when
   * defined, so a plain action `Button` never newly announces `selected`.
   */
  selected?: boolean;
};

export type TextProps = {
  children: ReactNode;
  variant?: TextVariant;
  color?: TextColor;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  /**
   * Cap on the OS font-size setting. Defaults are applied per variant; pass a
   * value only to override. Prose should stay uncapped for accessibility —
   * this exists for fixed-size chrome (badges, eyebrows, tiles) where an
   * unbounded multiplier breaks the layout instead of helping the reader.
   */
  maxFontSizeMultiplier?: number;
  /** Shrink to fit rather than wrap. Pair with numberOfLines. */
  adjustsFontSizeToFit?: boolean;
  /** Allow long-press copy — worth it for diagnostics the user must relay. */
  selectable?: boolean;
};

export type TextFieldValidationState = 'default' | 'valid' | 'invalid';

export type TextFieldProps = {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  validationState?: TextFieldValidationState;
  secureTextEntry?: boolean;
  multiline?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  editable?: boolean;
  onSubmitEditing?: () => void;
  returnKeyType?: 'done' | 'go' | 'next' | 'search' | 'send';
  /**
   * Hardware-key press hook for fields that own keyboard behaviors (the
   * terminal's arrow-key history, e.g.). Delivered by the base field; the
   * SwiftUI-backed iOS field has no key events, so iOS surfaces pair such
   * fields with on-screen affordances instead of relying on keys.
   */
  onKeyPress?: (event: { nativeEvent: { key: string } }) => void;
  style?: StyleProp<ViewStyle>;
  /** Called when the field gains focus (lets a host own its focus ring). */
  onFocus?: () => void;
  /** Called when the field loses focus. */
  onBlur?: () => void;
  /**
   * Overrides the validationState-derived label when a surface names its
   * field precisely (e.g. "Message input" instead of "Valid input").
   */
  accessibilityLabel?: string;
};

export type CardProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  interactive?: boolean;
  variant?: GlassVariant;
  padding?: number;
};

export type ScreenProps = {
  children: ReactNode;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  style?: StyleProp<ViewStyle>;
  /** Layered ambient blooms; disable on dense inset panes (e.g. terminal). */
  ambient?: boolean;
  parallaxX?: number;
  parallaxY?: number;
};

export type ScreenHeaderProps = {
  title?: string;
  subtitle?: string;
  onTrailingPress?: () => void;
  trailingIcon?: { ios: SFSymbol; android: string; web: string };
  trailing?: ReactNode;
  style?: StyleProp<ViewStyle>;
};