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
  style?: StyleProp<ViewStyle>;
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